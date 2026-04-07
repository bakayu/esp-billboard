use anchor_lang::prelude::*;

use crate::{constants::CONFIG_SEED, error::ErrorCode, state::Config};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::LEN,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    treasury: Pubkey,
    lamports_per_pixel: u64,
) -> Result<()> {
    require!(lamports_per_pixel > 0, ErrorCode::InvalidPrice);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = treasury;
    config.lamports_per_pixel = lamports_per_pixel;
    config.bump = ctx.bumps.config;

    Ok(())
}
