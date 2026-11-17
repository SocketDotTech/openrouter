use solana_program::{
    account_info::AccountInfo,
    declare_id, entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
};
use spl_token::{instruction::transfer_checked, state::Mint};

declare_id!("5oEzAP4izB65uRm2yDAEf9oALGwHpWkDfyKb8zBY3euC");
entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, input_mint, source, pool_input, output_mint, pool_output, destination, pool, token_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let data: &[u8; 16] = data
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let input_amount = u64::from_le_bytes(data[..8].try_into().unwrap());
    let output_amount = u64::from_le_bytes(data[8..].try_into().unwrap());
    let (pool_key, bump) = Pubkey::find_program_address(&[b"pool"], program_id);
    if pool.key != &pool_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let input_transfer = transfer_checked(
        token_program.key,
        source.key,
        input_mint.key,
        pool_input.key,
        authority.key,
        &[],
        input_amount,
        Mint::unpack(&input_mint.try_borrow_data()?)?.decimals,
    )?;
    invoke(
        &input_transfer,
        &[
            source.clone(),
            input_mint.clone(),
            pool_input.clone(),
            authority.clone(),
            token_program.clone(),
        ],
    )?;

    let output_transfer = transfer_checked(
        token_program.key,
        pool_output.key,
        output_mint.key,
        destination.key,
        pool.key,
        &[],
        output_amount,
        Mint::unpack(&output_mint.try_borrow_data()?)?.decimals,
    )?;
    invoke_signed(
        &output_transfer,
        &[
            pool_output.clone(),
            output_mint.clone(),
            destination.clone(),
            pool.clone(),
            token_program.clone(),
        ],
        &[&[b"pool", &[bump]]],
    )
}
