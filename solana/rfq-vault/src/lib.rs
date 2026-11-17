use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
    token_interface,
};
use solana_keccak_hasher::hashv;
use solana_secp256k1_recover::secp256k1_recover;

declare_id!("8gS67TJgSWTnExQZxwLmnsv1EBocZgUTqMGvTzbzLYZS");

const DOMAIN: &[u8] = b"BUNGEE_SOLANA_RFQ_V2";
const FULFIL: u8 = 1;
const REFUND: u8 = 2;
const SWAP_AND_FULFIL: u8 = 3;
const MARK_FOR_REFUND: u8 = 4;

#[program]
pub mod solana_rfq_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, solver: [u8; 20]) -> Result<()> {
        require!(solver != [0; 20], VaultError::InvalidSolver);
        ctx.accounts.vault.set_inner(Vault {
            owner: ctx.accounts.owner.key(),
            usdc_mint: ctx.accounts.usdc_mint.key(),
            swap_program: ctx.accounts.swap_program.key(),
            solver,
            bump: ctx.bumps.vault,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, quote_id: [u8; 32], amount: u64) -> Result<()> {
        let accounts = ctx.accounts;
        let before = accounts.vault_usdc.amount;
        transfer_usdc(
            &accounts.token_program,
            &accounts.usdc_mint,
            &accounts.user_usdc,
            &accounts.vault_usdc,
            &accounts.user.to_account_info(),
            &[],
            amount,
        )?;
        accounts.vault_usdc.reload()?;
        emit_deposit(
            &accounts.vault,
            quote_id,
            accounts.user.key(),
            before,
            accounts.vault_usdc.amount,
            amount,
        )
    }

    pub fn swap_and_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapAndDeposit<'info>>,
        quote_id: [u8; 32],
        min_usdc: u64,
        route: SwapRoute,
    ) -> Result<()> {
        let accounts = ctx.accounts;
        let before = accounts.vault_usdc.amount;
        let swap = route.instruction(
            accounts.swap_program.key(),
            ctx.remaining_accounts,
            accounts.user.key(),
        )?;
        require!(
            swap.accounts
                .iter()
                .any(|meta| meta.pubkey == accounts.vault_usdc.key() && meta.is_writable),
            VaultError::InvalidRoute
        );
        let mut swap_accounts = ctx.remaining_accounts.to_vec();
        swap_accounts.push(accounts.swap_program.to_account_info());
        invoke(&swap, &swap_accounts)?;
        accounts.vault_usdc.reload()?;
        emit_deposit(
            &accounts.vault,
            quote_id,
            accounts.user.key(),
            before,
            accounts.vault_usdc.amount,
            min_usdc,
        )
    }

    pub fn fulfil(
        ctx: Context<SettleUsdc>,
        quote_id: [u8; 32],
        nonce: u64,
        valid_until: u64,
        recipient: Pubkey,
        amount: u64,
        signature: [u8; 65],
    ) -> Result<()> {
        pay_usdc(
            ctx,
            quote_id,
            nonce,
            valid_until,
            recipient,
            amount,
            signature,
            FULFIL,
        )
    }

    pub fn refund(
        ctx: Context<SettleUsdc>,
        quote_id: [u8; 32],
        nonce: u64,
        valid_until: u64,
        recipient: Pubkey,
        amount: u64,
        signature: [u8; 65],
    ) -> Result<()> {
        pay_usdc(
            ctx,
            quote_id,
            nonce,
            valid_until,
            recipient,
            amount,
            signature,
            REFUND,
        )
    }

    pub fn mark_for_refund(
        ctx: Context<MarkForRefund>,
        quote_id: [u8; 32],
        nonce: u64,
        valid_until: u64,
        signature: [u8; 65],
    ) -> Result<()> {
        ctx.accounts.vault.authorize(
            ctx.program_id,
            &ctx.accounts.vault.key(),
            MARK_FOR_REFUND,
            &quote_id,
            nonce,
            valid_until,
            &[],
            &signature,
        )?;
        ctx.accounts.quote.status = MARK_FOR_REFUND;
        emit!(MarkedForRefund { quote_id });
        Ok(())
    }

    pub fn swap_and_fulfil<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapAndFulfil<'info>>,
        quote_id: [u8; 32],
        nonce: u64,
        valid_until: u64,
        output_mint: Pubkey,
        usdc_amount: u64,
        min_output: u64,
        route: SwapRoute,
        signature: [u8; 65],
    ) -> Result<()> {
        let accounts = ctx.accounts;
        let recipient = accounts.recipient.key();
        require!(
            output_mint != accounts.vault.usdc_mint && min_output > 0,
            VaultError::InvalidOutput
        );

        let swap = route.instruction(
            accounts.swap_program.key(),
            ctx.remaining_accounts,
            accounts.swap_authority.key(),
        )?;
        // The swap provider can use the prefunded swap account. The shared
        // vault and its signing authority stay outside the provider call.
        require!(
            swap.accounts
                .iter()
                .all(|meta| meta.pubkey != accounts.vault.key()
                    && meta.pubkey != accounts.vault_usdc.key())
                && swap
                    .accounts
                    .iter()
                    .any(|meta| meta.pubkey == accounts.swap_usdc.key() && meta.is_writable)
                && swap
                    .accounts
                    .iter()
                    .any(|meta| meta.pubkey == accounts.swap_authority.key() && meta.is_signer),
            VaultError::InvalidRoute
        );
        let route_hash = swap_digest(&swap.program_id, &swap.data, &swap.accounts);
        accounts.vault.authorize(
            ctx.program_id,
            &accounts.vault.key(),
            SWAP_AND_FULFIL,
            &quote_id,
            nonce,
            valid_until,
            &[
                recipient.as_ref(),
                output_mint.as_ref(),
                &usdc_amount.to_le_bytes(),
                &min_output.to_le_bytes(),
                &route_hash,
            ],
            &signature,
        )?;

        let recipient_output = accounts.recipient_output.to_account_info();
        let before_output = recipient_balance(&recipient_output, &recipient, &output_mint)?;
        let before_swap_usdc = accounts.swap_usdc.amount;
        transfer_usdc(
            &accounts.token_program,
            &accounts.usdc_mint,
            &accounts.vault_usdc,
            &accounts.swap_usdc,
            &accounts.vault.to_account_info(),
            &[&accounts.vault.seeds()],
            usdc_amount,
        )?;

        let vault_key = accounts.vault.key();
        let swap_seeds: &[&[u8]] = &[b"swap", vault_key.as_ref(), &[ctx.bumps.swap_authority]];
        let mut swap_accounts = ctx.remaining_accounts.to_vec();
        swap_accounts.push(accounts.swap_program.to_account_info());
        invoke_signed(&swap, &swap_accounts, &[swap_seeds])?;
        accounts.swap_usdc.reload()?;
        require!(
            accounts.swap_usdc.owner == accounts.swap_authority.key()
                && accounts.swap_usdc.delegate.is_none()
                && accounts.swap_usdc.close_authority.is_none(),
            VaultError::InvalidRoute
        );
        require_eq!(
            accounts.swap_usdc.amount,
            before_swap_usdc,
            VaultError::UnexpectedUsdcSpend
        );

        let after_output = recipient_balance(&recipient_output, &recipient, &output_mint)?;
        let amount = checked_output(before_output, after_output, min_output)?;
        accounts.quote.status = FULFIL;
        emit!(Fulfilled {
            quote_id,
            mint: output_mint,
            amount,
            recipient,
        });
        Ok(())
    }

    pub fn set_solver(ctx: Context<SetSolver>, solver: [u8; 20]) -> Result<()> {
        require!(solver != [0; 20], VaultError::InvalidSolver);
        ctx.accounts.vault.solver = solver;
        Ok(())
    }

    pub fn rescue_funds(ctx: Context<RescueFunds>, amount: u64) -> Result<()> {
        let accounts = ctx.accounts;
        transfer_usdc(
            &accounts.token_program,
            &accounts.usdc_mint,
            &accounts.vault_usdc,
            &accounts.recipient_usdc,
            &accounts.vault.to_account_info(),
            &[&accounts.vault.seeds()],
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: The PDA serves only as the owner of the swap USDC account.
    #[account(seeds = [b"swap", vault.key().as_ref()], bump)]
    pub swap_authority: UncheckedAccount<'info>,
    #[account(constraint = usdc_mint.decimals == 6 @ VaultError::InvalidOutput)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(init, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(init, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = swap_authority)]
    pub swap_usdc: Account<'info, TokenAccount>,
    /// CHECK: Only this executable swap program can be used for this vault.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    #[account(has_one = usdc_mint)]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapAndDeposit<'info> {
    pub user: Signer<'info>,
    #[account(has_one = usdc_mint, has_one = swap_program)]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// CHECK: Matches the configured swap program.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(quote_id: [u8; 32])]
pub struct SettleUsdc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = usdc_mint)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, space = 8 + QuoteState::INIT_SPACE, seeds = [
        b"quote", vault.key().as_ref(), quote_id.as_ref()
    ], bump)]
    pub quote: Account<'info, QuoteState>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint)]
    pub recipient_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote_id: [u8; 32])]
pub struct MarkForRefund<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, space = 8 + QuoteState::INIT_SPACE, seeds = [
        b"quote", vault.key().as_ref(), quote_id.as_ref()
    ], bump)]
    pub quote: Account<'info, QuoteState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote_id: [u8; 32])]
pub struct SwapAndFulfil<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = usdc_mint, has_one = swap_program)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, space = 8 + QuoteState::INIT_SPACE, seeds = [
        b"quote", vault.key().as_ref(), quote_id.as_ref()
    ], bump)]
    pub quote: Account<'info, QuoteState>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// CHECK: The PDA serves only as the owner of the swap USDC account.
    #[account(seeds = [b"swap", vault.key().as_ref()], bump)]
    pub swap_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = swap_authority)]
    pub swap_usdc: Account<'info, TokenAccount>,
    /// CHECK: Its key is signed by the solver.
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: Verified against the signed recipient and output mint around the swap.
    #[account(mut)]
    pub recipient_output: UncheckedAccount<'info>,
    /// CHECK: Matches the configured swap program.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetSolver<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct RescueFunds<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner, has_one = usdc_mint)]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint)]
    pub recipient_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub usdc_mint: Pubkey,
    pub swap_program: Pubkey,
    pub solver: [u8; 20],
    pub bump: u8,
}

impl Vault {
    fn seeds(&self) -> [&[u8]; 3] {
        [
            b"vault",
            self.owner.as_ref(),
            core::slice::from_ref(&self.bump),
        ]
    }

    fn authorize(
        &self,
        program_id: &Pubkey,
        vault: &Pubkey,
        action: u8,
        quote_id: &[u8; 32],
        nonce: u64,
        valid_until: u64,
        fields: &[&[u8]],
        signature: &[u8; 65],
    ) -> Result<()> {
        let now = u64::try_from(Clock::get()?.unix_timestamp)
            .map_err(|_| VaultError::AuthorizationExpired)?;
        require!(now < valid_until, VaultError::AuthorizationExpired);
        let message = action_digest(
            program_id,
            vault,
            action,
            quote_id,
            nonce,
            valid_until,
            fields,
        );
        let digest = hashv(&[b"\x19Ethereum Signed Message:\n32", &message]).to_bytes();
        let recovered = secp256k1_recover(&digest, signature[64], &signature[..64])
            .map_err(|_| VaultError::InvalidSignature)?;
        let address = hashv(&[&recovered.to_bytes()]).to_bytes();
        require!(address[12..] == self.solver, VaultError::InvalidSignature);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct QuoteState {
    pub status: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapRoute {
    pub data: Vec<u8>,
    pub flags: Vec<u8>,
}

impl SwapRoute {
    fn instruction(
        self,
        program_id: Pubkey,
        remaining: &[AccountInfo],
        authority: Pubkey,
    ) -> Result<Instruction> {
        require_eq!(self.flags.len(), remaining.len(), VaultError::InvalidRoute);
        let accounts = remaining
            .iter()
            .zip(self.flags)
            .map(|(account, flags)| {
                let is_signer = flags & 1 != 0;
                let is_writable = flags & 2 != 0;
                require!(
                    flags <= 3
                        && (!is_signer || account.key() == authority)
                        && (!is_writable || account.is_writable),
                    VaultError::InvalidRoute
                );
                Ok(AccountMeta {
                    pubkey: account.key(),
                    is_signer,
                    is_writable,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Instruction {
            program_id,
            accounts,
            data: self.data,
        })
    }
}

#[event]
pub struct Deposited {
    pub quote_id: [u8; 32],
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Fulfilled {
    pub quote_id: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct Refunded {
    pub quote_id: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct MarkedForRefund {
    pub quote_id: [u8; 32],
}

#[error_code]
pub enum VaultError {
    #[msg("Invalid solver address")]
    InvalidSolver,
    #[msg("Invalid solver signature")]
    InvalidSignature,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Invalid swap program accounts or privileges")]
    InvalidRoute,
    #[msg("Invalid output mint, recipient or token account")]
    InvalidOutput,
    #[msg("Received amount is below the minimum")]
    InsufficientOutput,
    #[msg("The swap did not spend the authorized USDC amount")]
    UnexpectedUsdcSpend,
    #[msg("The solver authorization has expired")]
    AuthorizationExpired,
}

fn transfer_usdc<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    require!(
        amount > 0 && from.key() != to.key(),
        VaultError::InvalidAmount
    );
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )
}

fn pay_usdc(
    ctx: Context<SettleUsdc>,
    quote_id: [u8; 32],
    nonce: u64,
    valid_until: u64,
    recipient: Pubkey,
    amount: u64,
    signature: [u8; 65],
    action: u8,
) -> Result<()> {
    let accounts = ctx.accounts;
    require_keys_eq!(
        accounts.recipient_usdc.owner,
        recipient,
        VaultError::InvalidOutput
    );
    accounts.vault.authorize(
        ctx.program_id,
        &accounts.vault.key(),
        action,
        &quote_id,
        nonce,
        valid_until,
        &[recipient.as_ref(), &amount.to_le_bytes()],
        &signature,
    )?;
    transfer_usdc(
        &accounts.token_program,
        &accounts.usdc_mint,
        &accounts.vault_usdc,
        &accounts.recipient_usdc,
        &accounts.vault.to_account_info(),
        &[&accounts.vault.seeds()],
        amount,
    )?;
    accounts.quote.status = action;
    if action == REFUND {
        emit!(Refunded {
            quote_id,
            mint: accounts.usdc_mint.key(),
            amount,
            recipient
        });
    } else {
        emit!(Fulfilled {
            quote_id,
            mint: accounts.usdc_mint.key(),
            amount,
            recipient
        });
    }
    Ok(())
}

fn emit_deposit(
    vault: &Vault,
    quote_id: [u8; 32],
    depositor: Pubkey,
    before: u64,
    after: u64,
    minimum: u64,
) -> Result<()> {
    require!(minimum > 0, VaultError::InvalidAmount);
    let amount = checked_output(before, after, minimum)?;
    emit!(Deposited {
        quote_id,
        depositor,
        mint: vault.usdc_mint,
        amount
    });
    Ok(())
}

fn checked_output(before: u64, after: u64, minimum: u64) -> Result<u64> {
    let amount = after
        .checked_sub(before)
        .ok_or(VaultError::InsufficientOutput)?;
    require_gte!(amount, minimum, VaultError::InsufficientOutput);
    Ok(amount)
}

fn recipient_balance(account: &AccountInfo, recipient: &Pubkey, mint: &Pubkey) -> Result<u64> {
    if *mint == Pubkey::default() {
        require_keys_eq!(account.key(), *recipient, VaultError::InvalidOutput);
        return Ok(account.lamports());
    }

    require!(
        *account.owner == token::ID || *account.owner == anchor_spl::token_2022::ID,
        VaultError::InvalidOutput
    );
    let data = account.try_borrow_data()?;
    let token = token_interface::TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| VaultError::InvalidOutput)?;
    require_keys_eq!(token.mint, *mint, VaultError::InvalidOutput);
    require_keys_eq!(token.owner, *recipient, VaultError::InvalidOutput);
    Ok(token.amount)
}

fn action_digest(
    program_id: &Pubkey,
    vault: &Pubkey,
    action: u8,
    quote_id: &[u8; 32],
    nonce: u64,
    valid_until: u64,
    fields: &[&[u8]],
) -> [u8; 32] {
    let action = [action];
    let nonce = nonce.to_le_bytes();
    let valid_until = valid_until.to_le_bytes();
    let mut parts: Vec<&[u8]> = vec![
        DOMAIN,
        program_id.as_ref(),
        vault.as_ref(),
        &action,
        quote_id,
        &nonce,
        &valid_until,
    ];
    parts.extend_from_slice(fields);
    hashv(&parts).to_bytes()
}

fn swap_digest(program_id: &Pubkey, data: &[u8], metas: &[AccountMeta]) -> [u8; 32] {
    let mut packed = Vec::with_capacity(metas.len() * 33);
    for meta in metas {
        packed.extend_from_slice(meta.pubkey.as_ref());
        packed.push(u8::from(meta.is_signer) | (u8::from(meta.is_writable) << 1));
    }
    hashv(&[program_id.as_ref(), &hashv(&[data]).to_bytes(), &packed]).to_bytes()
}

#[cfg(test)]
mod tests;
