use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Lamports per pixel must be greater than zero")]
    InvalidPrice,
    #[msg("Pixel count exceeds allowed frame size")]
    PixelCountTooLarge,
    #[msg("Math overflow while computing payment amount")]
    MathOverflow,
}
