use anchor_lang::prelude::*;

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub lamports_per_pixel: u64,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 32 + 32 + 8 + 1;
}
