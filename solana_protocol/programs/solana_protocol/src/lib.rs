pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("F1sgjjEg39qTUhgK8CbQLo35AaYhbS5CoeZ3LDNG8Una");

#[program]
pub mod solana_protocol {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        lamports_per_pixel: u64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, treasury, lamports_per_pixel)
    }

    pub fn pay_per_pixel(ctx: Context<PayPerPixel>, pixel_count: u16) -> Result<()> {
        instructions::pay_per_pixel::handle_pay_per_pixel(ctx, pixel_count)
    }
}
