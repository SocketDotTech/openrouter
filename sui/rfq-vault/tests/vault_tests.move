#[test_only, allow(deprecated_usage, implicit_const_copy)]
module rfq_vault::vault_tests;

use rfq_vault::vault::{Self, Vault};
use sui::coin::{Self, Coin, TreasuryCap};
use sui::ecdsa_k1;
use sui::test_scenario::{Self, Scenario};
use sui::transfer;
use sui::url;

public struct VAULT_TESTS has drop {}

const OWNER: address = @0xA11CE;
const USER: address = @0xB0B;
const RECEIVER: address = @0xCAFE;
const OTHER: address = @0xBEEF;

const AMOUNT: u64 = 1000;
const DOMAIN: vector<u8> = b"socket-rfq-vault-sui-test-v1";
const SEED: vector<u8> = b"Some random seed, 32 bytes long.";

#[test]
fun deposit_custodies_coin_and_duplicate_deposit_is_allowed() {
    let mut scenario = setup();
    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let mut treasury = scenario.take_from_address<TreasuryCap<VAULT_TESTS>>(OWNER);

        vault::deposit<VAULT_TESTS>(
            &mut vault,
            quote_id(1),
            mint(&mut treasury, AMOUNT, &mut scenario),
            scenario.ctx(),
        );
        vault::deposit<VAULT_TESTS>(
            &mut vault,
            quote_id(1),
            mint(&mut treasury, 2 * AMOUNT, &mut scenario),
            scenario.ctx(),
        );

        assert!(vault::vault_balance<VAULT_TESTS>(&vault) == 3 * AMOUNT);
        assert!(!vault::is_quote_used(&vault, quote_id(1)));

        transfer::public_transfer(treasury, OWNER);
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun fulfil_with_solver_signature_releases_funds_and_blocks_replay() {
    let mut scenario = setup_funded_vault(2 * AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(2);
        let nonce = 7;
        let signature = sign_fulfil<VAULT_TESTS>(&vault, copy quote_id, nonce, AMOUNT, RECEIVER);

        vault::fulfil<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            nonce,
            AMOUNT,
            RECEIVER,
            signature,
            scenario.ctx(),
        );

        assert!(vault::vault_balance<VAULT_TESTS>(&vault) == AMOUNT);
        assert!(vault::is_quote_used(&vault, copy quote_id));
        test_scenario::return_shared(vault);
    };
    scenario.next_tx(RECEIVER);
    {
        let coin = scenario.take_from_address<Coin<VAULT_TESTS>>(RECEIVER);
        assert!(coin.value() == AMOUNT);
        transfer::public_transfer(coin, OWNER);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun fulfil_replay_aborts() {
    let mut scenario = setup_funded_vault(2 * AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(3);
        let signature = sign_fulfil<VAULT_TESTS>(&vault, copy quote_id, 8, AMOUNT, RECEIVER);

        vault::fulfil<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            8,
            AMOUNT,
            RECEIVER,
            copy signature,
            scenario.ctx(),
        );
        vault::fulfil<VAULT_TESTS>(
            &mut vault,
            quote_id,
            8,
            AMOUNT,
            RECEIVER,
            signature,
            scenario.ctx(),
        );

        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun fulfil_after_refund_aborts() {
    let mut scenario = setup_funded_vault(2 * AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(4);
        let refund_signature = sign_refund<VAULT_TESTS>(&vault, copy quote_id, 9, AMOUNT, RECEIVER);
        vault::refund<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            9,
            AMOUNT,
            RECEIVER,
            refund_signature,
            scenario.ctx(),
        );

        let fulfil_signature = sign_fulfil<VAULT_TESTS>(&vault, copy quote_id, 10, AMOUNT, RECEIVER);
        vault::fulfil<VAULT_TESTS>(
            &mut vault,
            quote_id,
            10,
            AMOUNT,
            RECEIVER,
            fulfil_signature,
            scenario.ctx(),
        );

        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun mark_for_refund_consumes_quote_id_and_blocks_refund() {
    let mut scenario = setup_funded_vault(AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(5);
        let signature = sign_mark_for_refund(&vault, copy quote_id, 11);

        vault::mark_for_refund(&mut vault, copy quote_id, 11, signature);

        assert!(vault::is_quote_used(&vault, copy quote_id));
        assert!(vault::is_marked_for_refund(&vault, copy quote_id));
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun refund_after_mark_for_refund_aborts() {
    let mut scenario = setup_funded_vault(AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(6);
        let mark_signature = sign_mark_for_refund(&vault, copy quote_id, 12);
        vault::mark_for_refund(&mut vault, copy quote_id, 12, mark_signature);

        let refund_signature = sign_refund<VAULT_TESTS>(&vault, copy quote_id, 13, AMOUNT, RECEIVER);
        vault::refund<VAULT_TESTS>(
            &mut vault,
            quote_id,
            13,
            AMOUNT,
            RECEIVER,
            refund_signature,
            scenario.ctx(),
        );

        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun refund_with_solver_signature_releases_funds() {
    let mut scenario = setup_funded_vault(AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(7);
        let signature = sign_refund<VAULT_TESTS>(&vault, copy quote_id, 14, AMOUNT, RECEIVER);

        vault::refund<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            14,
            AMOUNT,
            RECEIVER,
            signature,
            scenario.ctx(),
        );

        assert!(vault::vault_balance<VAULT_TESTS>(&vault) == 0);
        assert!(vault::is_quote_used(&vault, quote_id));
        test_scenario::return_shared(vault);
    };
    scenario.next_tx(RECEIVER);
    {
        let coin = scenario.take_from_address<Coin<VAULT_TESTS>>(RECEIVER);
        assert!(coin.value() == AMOUNT);
        transfer::public_transfer(coin, OWNER);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun refund_replay_aborts() {
    let mut scenario = setup_funded_vault(2 * AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(8);
        let signature = sign_refund<VAULT_TESTS>(&vault, copy quote_id, 15, AMOUNT, RECEIVER);

        vault::refund<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            15,
            AMOUNT,
            RECEIVER,
            copy signature,
            scenario.ctx(),
        );
        vault::refund<VAULT_TESTS>(
            &mut vault,
            quote_id,
            15,
            AMOUNT,
            RECEIVER,
            signature,
            scenario.ctx(),
        );

        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun refund_after_fulfil_aborts() {
    let mut scenario = setup_funded_vault(2 * AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let quote_id = quote_id(9);
        let fulfil_signature = sign_fulfil<VAULT_TESTS>(&vault, copy quote_id, 16, AMOUNT, RECEIVER);
        vault::fulfil<VAULT_TESTS>(
            &mut vault,
            copy quote_id,
            16,
            AMOUNT,
            RECEIVER,
            fulfil_signature,
            scenario.ctx(),
        );

        let refund_signature = sign_refund<VAULT_TESTS>(&vault, copy quote_id, 17, AMOUNT, RECEIVER);
        vault::refund<VAULT_TESTS>(
            &mut vault,
            quote_id,
            17,
            AMOUNT,
            RECEIVER,
            refund_signature,
            scenario.ctx(),
        );

        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_PAUSED)]
fun paused_vault_blocks_deposit() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut vault = scenario.take_shared<Vault>();
        vault::pause(&mut vault, scenario.ctx());
        test_scenario::return_shared(vault);
    };
    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let mut treasury = scenario.take_from_address<TreasuryCap<VAULT_TESTS>>(OWNER);
        vault::deposit<VAULT_TESTS>(
            &mut vault,
            quote_id(10),
            mint(&mut treasury, AMOUNT, &mut scenario),
            scenario.ctx(),
        );

        transfer::public_transfer(treasury, OWNER);
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun owner_can_rescue_and_update_admin_state() {
    let mut scenario = setup_funded_vault(AMOUNT);
    scenario.next_tx(OWNER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let new_keypair = ecdsa_k1::secp256k1_keypair_from_seed(
            &b"Another random 32 byte test seed",
        );

        vault::set_solver_pubkey(&mut vault, *new_keypair.public_key(), scenario.ctx());
        vault::pause(&mut vault, scenario.ctx());
        assert!(vault::is_paused(&vault));
        vault::unpause(&mut vault, scenario.ctx());
        assert!(!vault::is_paused(&vault));
        vault::rescue<VAULT_TESTS>(&mut vault, AMOUNT, RECEIVER, scenario.ctx());
        vault::transfer_ownership(&mut vault, OTHER, scenario.ctx());

        assert!(vault::owner(&vault) == OTHER);
        assert!(vault::vault_balance<VAULT_TESTS>(&vault) == 0);
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_ONLY_OWNER)]
fun non_owner_cannot_rescue() {
    let mut scenario = setup_funded_vault(AMOUNT);
    scenario.next_tx(OTHER);
    {
        let mut vault = scenario.take_shared<Vault>();
        vault::rescue<VAULT_TESTS>(&mut vault, AMOUNT, RECEIVER, scenario.ctx());
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = vault::E_INVALID_QUOTE_ID)]
fun deposit_rejects_non_32_byte_quote_id() {
    let mut scenario = setup();
    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let mut treasury = scenario.take_from_address<TreasuryCap<VAULT_TESTS>>(OWNER);
        vault::deposit<VAULT_TESTS>(
            &mut vault,
            b"too-short",
            mint(&mut treasury, AMOUNT, &mut scenario),
            scenario.ctx(),
        );

        transfer::public_transfer(treasury, OWNER);
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun create_vault_can_set_owner_different_from_deployer() {
    let mut scenario = test_scenario::begin(OTHER);
    let keypair = solver_keypair();
    vault::create_vault(OWNER, *keypair.public_key(), DOMAIN, scenario.ctx());

    scenario.next_tx(OWNER);
    {
        let vault = scenario.take_shared<Vault>();
        assert!(vault::owner(&vault) == OWNER);
        test_scenario::return_shared(vault);
    };
    scenario.end();
}

fun setup(): Scenario {
    let mut scenario = test_scenario::begin(OWNER);
    let keypair = solver_keypair();
    let (treasury, metadata) = coin::create_currency(
        VAULT_TESTS {},
        6,
        b"TEST",
        b"Test Coin",
        b"RFQ vault test coin",
        option::some(url::new_unsafe_from_bytes(b"https://socket.tech")),
        scenario.ctx(),
    );

    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury, OWNER);
    vault::create_vault(OWNER, *keypair.public_key(), DOMAIN, scenario.ctx());

    scenario
}

fun setup_funded_vault(amount: u64): Scenario {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut vault = scenario.take_shared<Vault>();
        let mut treasury = scenario.take_from_address<TreasuryCap<VAULT_TESTS>>(OWNER);
        vault::fund<VAULT_TESTS>(
            &mut vault,
            mint(&mut treasury, amount, &mut scenario),
            scenario.ctx(),
        );
        transfer::public_transfer(treasury, OWNER);
        test_scenario::return_shared(vault);
    };

    scenario
}

fun mint(
    treasury: &mut TreasuryCap<VAULT_TESTS>,
    amount: u64,
    scenario: &mut Scenario,
): Coin<VAULT_TESTS> {
    coin::from_balance(treasury.mint_balance<VAULT_TESTS>(amount), scenario.ctx())
}

fun sign_fulfil<T>(
    vault: &Vault,
    quote_id: vector<u8>,
    nonce: u64,
    amount: u64,
    receiver: address,
): vector<u8> {
    ecdsa_k1::secp256k1_sign(
        solver_keypair().private_key(),
        &vault::fulfil_message<T>(vault, quote_id, nonce, amount, receiver),
        vault::signature_hash_algorithm(),
        false,
    )
}

fun sign_refund<T>(
    vault: &Vault,
    quote_id: vector<u8>,
    nonce: u64,
    amount: u64,
    receiver: address,
): vector<u8> {
    ecdsa_k1::secp256k1_sign(
        solver_keypair().private_key(),
        &vault::refund_message<T>(vault, quote_id, nonce, amount, receiver),
        vault::signature_hash_algorithm(),
        false,
    )
}

fun sign_mark_for_refund(vault: &Vault, quote_id: vector<u8>, nonce: u64): vector<u8> {
    ecdsa_k1::secp256k1_sign(
        solver_keypair().private_key(),
        &vault::mark_for_refund_message(vault, quote_id, nonce),
        vault::signature_hash_algorithm(),
        false,
    )
}

fun solver_keypair(): ecdsa_k1::KeyPair {
    ecdsa_k1::secp256k1_keypair_from_seed(&SEED)
}

fun quote_id(id: u8): vector<u8> {
    vector[
        id, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
    ]
}
