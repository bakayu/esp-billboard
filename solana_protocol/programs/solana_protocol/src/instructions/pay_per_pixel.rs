use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use crate::{
    constants::{CONFIG_SEED, MAX_PIXELS},
    error::ErrorCode,
    state::Config,
};

#[derive(Accounts)]
pub struct PayPerPixel<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.treasury)]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_pay_per_pixel(ctx: Context<PayPerPixel>, pixel_count: u16) -> Result<()> {
    require!(pixel_count <= MAX_PIXELS, ErrorCode::PixelCountTooLarge);

    let amount = ctx
        .accounts
        .config
        .lamports_per_pixel
        .checked_mul(pixel_count as u64)
        .ok_or(ErrorCode::MathOverflow)?;

    if amount == 0 {
        return Ok(());
    }

    let ix = system_instruction::transfer(
        &ctx.accounts.payer.key(),
        &ctx.accounts.treasury.key(),
        amount,
    );

    invoke(
        &ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
        ],
    )?;

    Ok(())
}
