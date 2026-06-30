#[allow(lint(public_entry))]
module rfq_vault::vault {
    use std::bcs;
    use std::ascii::{Self, String};
    use std::type_name;
    use sui::bag::{Self, Bag};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::ecdsa_k1;
    use sui::event;
    use sui::table::{Self, Table};

    const ACTION_FULFIL: u64 = 1;
    const ACTION_REFUND: u64 = 2;
    const ACTION_MARK_FOR_REFUND: u64 = 4;

    const HASH_SHA256: u8 = 1;
    const QUOTE_ID_LENGTH: u64 = 32;
    const SECP256K1_PUBLIC_KEY_LENGTH: u64 = 33;
    const SECP256K1_SIGNATURE_LENGTH: u64 = 64;

    const E_INVALID_QUOTE_ID: u64 = 1;
    const E_INVALID_SIGNATURE: u64 = 2;
    const E_PAUSED: u64 = 3;
    const E_ONLY_OWNER: u64 = 4;
    const E_INVALID_SOLVER_PUBKEY: u64 = 5;
    const E_INVALID_DOMAIN: u64 = 6;
    const E_INVALID_OWNER: u64 = 7;

    public struct Vault has key {
        id: UID,
        owner: address,
        solver_pubkey: vector<u8>,
        domain: vector<u8>,
        paused: bool,
        balances: Bag,
        quote_used: Table<vector<u8>, bool>,
        marked_for_refund: Table<vector<u8>, bool>,
    }

    public struct Deposited has copy, drop {
        quote_id: vector<u8>,
        token_type: String,
        amount: u64,
        sender: address,
    }

    public struct Fulfilled has copy, drop {
        quote_id: vector<u8>,
        token_type: String,
        amount: u64,
        receiver: address,
    }

    public struct MarkedForRefund has copy, drop {
        quote_id: vector<u8>,
    }

    public struct Refunded has copy, drop {
        quote_id: vector<u8>,
        token_type: String,
        amount: u64,
        receiver: address,
    }

    public struct SettlementMessage has drop {
        domain: vector<u8>,
        vault: address,
        action: u64,
        quote_id: vector<u8>,
        nonce: u64,
        token_type: vector<u8>,
        amount: u64,
        receiver: address,
    }

    public struct MarkForRefundMessage has drop {
        domain: vector<u8>,
        vault: address,
        action: u64,
        quote_id: vector<u8>,
        nonce: u64,
    }

    public entry fun create_vault(
        owner: address,
        solver_pubkey: vector<u8>,
        domain: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(owner != @0x0, E_INVALID_OWNER);
        assert_valid_solver_pubkey(&solver_pubkey);
        assert!(domain.length() > 0, E_INVALID_DOMAIN);

        let vault = Vault {
            id: object::new(ctx),
            owner,
            solver_pubkey,
            domain,
            paused: false,
            balances: bag::new(ctx),
            quote_used: table::new(ctx),
            marked_for_refund: table::new(ctx),
        };

        transfer::share_object(vault);
    }

    public entry fun deposit<T>(
        vault: &mut Vault,
        quote_id: vector<u8>,
        coin: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert_not_paused(vault);
        assert_valid_quote_id(&quote_id);

        let amount = coin::value<T>(&coin);
        coin::put<T>(balance_mut_or_create<T>(vault), coin);

        event::emit(Deposited {
            quote_id,
            token_type: token_type<T>(),
            amount,
            sender: tx_context::sender(ctx),
        });
    }

    public entry fun fulfil<T>(
        vault: &mut Vault,
        quote_id: vector<u8>,
        nonce: u64,
        amount: u64,
        receiver: address,
        signature: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert_not_paused(vault);

        let message = fulfil_message<T>(vault, copy quote_id, nonce, amount, receiver);
        verify_signature(vault, &message, &signature);
        mark_quote_id(vault, copy quote_id);

        let coin = coin::take<T>(existing_balance_mut<T>(vault), amount, ctx);
        transfer::public_transfer(coin, receiver);

        event::emit(Fulfilled {
            quote_id,
            token_type: token_type<T>(),
            amount,
            receiver,
        });
    }

    public entry fun mark_for_refund(
        vault: &mut Vault,
        quote_id: vector<u8>,
        nonce: u64,
        signature: vector<u8>,
    ) {
        assert_not_paused(vault);

        let message = mark_for_refund_message(vault, copy quote_id, nonce);
        verify_signature(vault, &message, &signature);
        mark_quote_id(vault, copy quote_id);
        table::add<vector<u8>, bool>(&mut vault.marked_for_refund, copy quote_id, true);

        event::emit(MarkedForRefund { quote_id });
    }

    public entry fun refund<T>(
        vault: &mut Vault,
        quote_id: vector<u8>,
        nonce: u64,
        amount: u64,
        receiver: address,
        signature: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert_not_paused(vault);

        let message = refund_message<T>(vault, copy quote_id, nonce, amount, receiver);
        verify_signature(vault, &message, &signature);
        mark_quote_id(vault, copy quote_id);

        let coin = coin::take<T>(existing_balance_mut<T>(vault), amount, ctx);
        transfer::public_transfer(coin, receiver);

        event::emit(Refunded {
            quote_id,
            token_type: token_type<T>(),
            amount,
            receiver,
        });
    }

    public entry fun fund<T>(
        vault: &mut Vault,
        coin: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert_owner(vault, ctx);
        coin::put<T>(balance_mut_or_create<T>(vault), coin);
    }

    public entry fun rescue<T>(
        vault: &mut Vault,
        amount: u64,
        receiver: address,
        ctx: &mut TxContext,
    ) {
        assert_owner(vault, ctx);

        let coin = coin::take<T>(existing_balance_mut<T>(vault), amount, ctx);
        transfer::public_transfer(coin, receiver);
    }

    public entry fun pause(vault: &mut Vault, ctx: &mut TxContext) {
        assert_owner(vault, ctx);
        vault.paused = true;
    }

    public entry fun unpause(vault: &mut Vault, ctx: &mut TxContext) {
        assert_owner(vault, ctx);
        vault.paused = false;
    }

    public entry fun set_solver_pubkey(
        vault: &mut Vault,
        solver_pubkey: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert_owner(vault, ctx);
        assert_valid_solver_pubkey(&solver_pubkey);
        vault.solver_pubkey = solver_pubkey;
    }

    public entry fun transfer_ownership(
        vault: &mut Vault,
        new_owner: address,
        ctx: &mut TxContext,
    ) {
        assert_owner(vault, ctx);
        assert!(new_owner != @0x0, E_INVALID_OWNER);
        vault.owner = new_owner;
    }

    public fun owner(vault: &Vault): address {
        vault.owner
    }

    public fun solver_pubkey(vault: &Vault): vector<u8> {
        copy vault.solver_pubkey
    }

    public fun domain(vault: &Vault): vector<u8> {
        copy vault.domain
    }

    public fun is_paused(vault: &Vault): bool {
        vault.paused
    }

    public fun is_quote_used(vault: &Vault, quote_id: vector<u8>): bool {
        assert_valid_quote_id(&quote_id);
        table::contains<vector<u8>, bool>(&vault.quote_used, quote_id)
    }

    public fun is_marked_for_refund(vault: &Vault, quote_id: vector<u8>): bool {
        assert_valid_quote_id(&quote_id);
        table::contains<vector<u8>, bool>(&vault.marked_for_refund, quote_id)
    }

    public fun vault_balance<T>(vault: &Vault): u64 {
        let key = token_key<T>();
        if (bag::contains_with_type<vector<u8>, Balance<T>>(&vault.balances, copy key)) {
            balance::value<T>(bag::borrow<vector<u8>, Balance<T>>(&vault.balances, key))
        } else {
            0
        }
    }

    public fun fulfil_message<T>(
        vault: &Vault,
        quote_id: vector<u8>,
        nonce: u64,
        amount: u64,
        receiver: address,
    ): vector<u8> {
        assert_valid_quote_id(&quote_id);
        settlement_message<T>(vault, ACTION_FULFIL, quote_id, nonce, amount, receiver)
    }

    public fun refund_message<T>(
        vault: &Vault,
        quote_id: vector<u8>,
        nonce: u64,
        amount: u64,
        receiver: address,
    ): vector<u8> {
        assert_valid_quote_id(&quote_id);
        settlement_message<T>(vault, ACTION_REFUND, quote_id, nonce, amount, receiver)
    }

    public fun mark_for_refund_message(
        vault: &Vault,
        quote_id: vector<u8>,
        nonce: u64,
    ): vector<u8> {
        assert_valid_quote_id(&quote_id);
        bcs::to_bytes(&MarkForRefundMessage {
            domain: copy vault.domain,
            vault: object::uid_to_address(&vault.id),
            action: ACTION_MARK_FOR_REFUND,
            quote_id,
            nonce,
        })
    }

    public fun signature_hash_algorithm(): u8 {
        HASH_SHA256
    }

    fun settlement_message<T>(
        vault: &Vault,
        action: u64,
        quote_id: vector<u8>,
        nonce: u64,
        amount: u64,
        receiver: address,
    ): vector<u8> {
        bcs::to_bytes(&SettlementMessage {
            domain: copy vault.domain,
            vault: object::uid_to_address(&vault.id),
            action,
            quote_id,
            nonce,
            token_type: token_key<T>(),
            amount,
            receiver,
        })
    }

    fun verify_signature(vault: &Vault, message: &vector<u8>, signature: &vector<u8>) {
        assert!(signature.length() == SECP256K1_SIGNATURE_LENGTH, E_INVALID_SIGNATURE);
        assert!(
            ecdsa_k1::secp256k1_verify(
                signature,
                &vault.solver_pubkey,
                message,
                HASH_SHA256,
            ),
            E_INVALID_SIGNATURE,
        );
    }

    fun balance_mut_or_create<T>(vault: &mut Vault): &mut Balance<T> {
        let key = token_key<T>();
        if (!bag::contains_with_type<vector<u8>, Balance<T>>(&vault.balances, copy key)) {
            bag::add<vector<u8>, Balance<T>>(
                &mut vault.balances,
                copy key,
                balance::zero<T>(),
            );
        };

        bag::borrow_mut<vector<u8>, Balance<T>>(&mut vault.balances, key)
    }

    fun existing_balance_mut<T>(vault: &mut Vault): &mut Balance<T> {
        bag::borrow_mut<vector<u8>, Balance<T>>(&mut vault.balances, token_key<T>())
    }

    fun mark_quote_id(vault: &mut Vault, quote_id: vector<u8>) {
        assert!(
            !table::contains<vector<u8>, bool>(&vault.quote_used, copy quote_id),
            E_INVALID_QUOTE_ID,
        );
        table::add<vector<u8>, bool>(&mut vault.quote_used, quote_id, true);
    }

    fun assert_not_paused(vault: &Vault) {
        assert!(!vault.paused, E_PAUSED);
    }

    fun assert_owner(vault: &Vault, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == vault.owner, E_ONLY_OWNER);
    }

    fun assert_valid_quote_id(quote_id: &vector<u8>) {
        assert!(quote_id.length() == QUOTE_ID_LENGTH, E_INVALID_QUOTE_ID);
    }

    fun assert_valid_solver_pubkey(solver_pubkey: &vector<u8>) {
        assert!(
            solver_pubkey.length() == SECP256K1_PUBLIC_KEY_LENGTH,
            E_INVALID_SOLVER_PUBKEY,
        );
    }

    fun token_key<T>(): vector<u8> {
        ascii::into_bytes(token_type<T>())
    }

    fun token_type<T>(): String {
        type_name::into_string(type_name::with_original_ids<T>())
    }
}
