use super::*;

#[test]
fn action_digest_binds_settlement_and_vault_domain() {
    let program = Pubkey::new_from_array([1; 32]);
    let vault = Pubkey::new_from_array([2; 32]);
    let other_key = Pubkey::new_from_array([3; 32]);
    let quote = [4; 32];
    let other_quote = [5; 32];
    let fields: &[&[u8]] = &[b"amount", b"recipient"];
    let digest = action_digest(&program, &vault, 1, &quote, 6, 7, fields);

    let changes = [
        (
            "program",
            action_digest(&other_key, &vault, 1, &quote, 6, 7, fields),
        ),
        (
            "vault",
            action_digest(&program, &other_key, 1, &quote, 6, 7, fields),
        ),
        (
            "action",
            action_digest(&program, &vault, 2, &quote, 6, 7, fields),
        ),
        (
            "quote",
            action_digest(&program, &vault, 1, &other_quote, 6, 7, fields),
        ),
        (
            "nonce",
            action_digest(&program, &vault, 1, &quote, 8, 7, fields),
        ),
        (
            "expiry",
            action_digest(&program, &vault, 1, &quote, 6, 8, fields),
        ),
        (
            "fields",
            action_digest(&program, &vault, 1, &quote, 6, 7, &[b"amount", b"other"]),
        ),
    ];
    for (field, changed_digest) in changes {
        assert_ne!(digest, changed_digest, "changed {field}");
    }
}

#[test]
fn swap_digest_binds_program_calldata_and_ordered_account_metadata() {
    let program = Pubkey::new_from_array([1; 32]);
    let other_program = Pubkey::new_from_array([2; 32]);
    let source = AccountMeta::new(Pubkey::new_from_array([3; 32]), false);
    let authority = AccountMeta::new_readonly(Pubkey::new_from_array([4; 32]), true);
    let metas = [source.clone(), authority.clone()];
    let data = b"swap";
    let digest = swap_digest(&program, data, &metas);

    let reordered = [authority.clone(), source.clone()];
    let changed_key = [AccountMeta::new(other_program, false), authority.clone()];
    let changed_signer = [
        source.clone(),
        AccountMeta::new_readonly(authority.pubkey, false),
    ];
    let changed_writable = [AccountMeta::new_readonly(source.pubkey, false), authority];
    let changes = [
        ("program", swap_digest(&other_program, data, &metas)),
        ("calldata", swap_digest(&program, b"swAp", &metas)),
        ("account order", swap_digest(&program, data, &reordered)),
        ("account key", swap_digest(&program, data, &changed_key)),
        ("signer flag", swap_digest(&program, data, &changed_signer)),
        (
            "writable flag",
            swap_digest(&program, data, &changed_writable),
        ),
    ];
    for (field, changed_digest) in changes {
        assert_ne!(digest, changed_digest, "changed {field}");
    }
}
