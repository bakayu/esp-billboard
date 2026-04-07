const anchor = require("@anchor-lang/core");
const { web3 } = anchor;
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function expandHome(inputPath) {
    if (!inputPath) return inputPath;
    if (inputPath.startsWith("~/")) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
}

function readKeypair(filePath) {
    const fullPath = expandHome(filePath);
    const raw = fs.readFileSync(fullPath, "utf8");
    const bytes = JSON.parse(raw);
    return web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function discriminator(name) {
    return crypto
        .createHash("sha256")
        .update(`global:${name}`)
        .digest()
        .subarray(0, 8);
}

function u64Le(value) {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(value));
    return out;
}

function parseLamportsPerPixel(accountData) {
    if (!accountData || accountData.length < 81) return null;
    return Number(accountData.readBigUInt64LE(72));
}

async function ensurePayerFunds(connection, payer, rpcUrl) {
    const cluster = inferClusterFromRpc(rpcUrl);
    const current = await connection.getBalance(payer.publicKey, "confirmed");
    if (current > 0) return;

    if (cluster === "localnet") {
        console.log("Payer has 0 lamports on localnet, requesting airdrop...");
        const sig = await connection.requestAirdrop(
            payer.publicKey,
            web3.LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(sig, "confirmed");
        const after = await connection.getBalance(payer.publicKey, "confirmed");
        if (after <= 0) {
            throw new Error(
                "Airdrop did not fund payer. Is your local validator running with faucet enabled?",
            );
        }
        console.log("Airdrop complete. Payer balance:", after, "lamports");
        return;
    }

    throw new Error(
        "Payer has 0 lamports. Fund this wallet before init: " +
            payer.publicKey.toBase58(),
    );
}

function inferClusterFromRpc(rpcUrl) {
    const url = String(rpcUrl || "").toLowerCase();
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return "localnet";
    }
    if (url.includes("devnet")) return "devnet";
    if (url.includes("testnet")) return "testnet";
    if (url.includes("mainnet")) return "mainnet";
    return "localnet";
}

function readFileIfExists(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
}

function programIdFromAnchorToml(anchorTomlText, cluster) {
    if (!anchorTomlText) return "";
    const sectionRegex = new RegExp(
        String.raw`\[programs\.${cluster}\]([\s\S]*?)(?:\n\[|$)`,
    );
    const sectionMatch = anchorTomlText.match(sectionRegex);
    if (!sectionMatch) return "";
    const body = sectionMatch[1];
    const lineMatch = body.match(/solana_protocol\s*=\s*"([^"]+)"/);
    return lineMatch ? lineMatch[1] : "";
}

function programIdFromDeclareId(libRsText) {
    if (!libRsText) return "";
    const match = libRsText.match(/declare_id!\("([^"]+)"\)/);
    return match ? match[1] : "";
}

function programIdFromDeployKeypair() {
    const keypairPath = path.resolve(
        process.cwd(),
        "target/deploy/solana_protocol-keypair.json",
    );
    const raw = readFileIfExists(keypairPath);
    if (!raw) return "";
    try {
        const bytes = JSON.parse(raw);
        const kp = web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
        return kp.publicKey.toBase58();
    } catch {
        return "";
    }
}

function resolveProgramId(rpcUrl) {
    if (process.env.PROGRAM_ID) {
        return { value: process.env.PROGRAM_ID, source: "PROGRAM_ID" };
    }
    if (process.env.VITE_SOLANA_PROGRAM_ID) {
        return {
            value: process.env.VITE_SOLANA_PROGRAM_ID,
            source: "VITE_SOLANA_PROGRAM_ID",
        };
    }

    const cluster = inferClusterFromRpc(rpcUrl);
    const anchorTomlPath = path.resolve(process.cwd(), "Anchor.toml");
    const anchorToml = readFileIfExists(anchorTomlPath);
    const fromAnchorToml = programIdFromAnchorToml(anchorToml, cluster);
    if (fromAnchorToml) {
        return {
            value: fromAnchorToml,
            source: `Anchor.toml [programs.${cluster}]`,
        };
    }

    const fromDeployKeypair = programIdFromDeployKeypair();
    if (fromDeployKeypair) {
        return {
            value: fromDeployKeypair,
            source: "target/deploy/solana_protocol-keypair.json",
        };
    }

    const libRsPath = path.resolve(
        process.cwd(),
        "programs/solana_protocol/src/lib.rs",
    );
    const libRs = readFileIfExists(libRsPath);
    const fromDeclareId = programIdFromDeclareId(libRs);
    if (fromDeclareId) {
        return { value: fromDeclareId, source: "declare_id! in lib.rs" };
    }

    return { value: "", source: "" };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const showOnly = args.has("--show");

    const rpcUrl =
        process.env.RPC_URL ||
        process.env.ANCHOR_PROVIDER_URL ||
        "http://127.0.0.1:8899";
    const walletPath =
        process.env.WALLET ||
        process.env.ANCHOR_WALLET ||
        "~/.config/solana/esp.json";
    const programIdResolved = resolveProgramId(rpcUrl);
    const programIdString = programIdResolved.value;
    const lamportsPerPixel = Number(process.env.LAMPORTS_PER_PIXEL || "2000");

    if (!programIdString) {
        throw new Error(
            "Missing program id. Set PROGRAM_ID, or define VITE_SOLANA_PROGRAM_ID, or ensure Anchor.toml has [programs.<cluster>].",
        );
    }
    if (!Number.isFinite(lamportsPerPixel) || lamportsPerPixel <= 0) {
        throw new Error("LAMPORTS_PER_PIXEL must be a positive number.");
    }

    const payer = readKeypair(walletPath);
    const connection = new web3.Connection(rpcUrl, "confirmed");
    await ensurePayerFunds(connection, payer, rpcUrl);
    const programId = new web3.PublicKey(programIdString);
    const treasury = new web3.PublicKey(
        process.env.TREASURY || payer.publicKey.toBase58(),
    );

    const [configPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programId,
    );

    const existing = await connection.getAccountInfo(configPda, "confirmed");
    console.log("Program ID source:", programIdResolved.source || "manual");
    console.log("Program ID:", programId.toBase58());
    console.log("RPC URL:", rpcUrl);
    if (existing?.data) {
        const existingPrice = parseLamportsPerPixel(existing.data);
        console.log("Config PDA already initialized:", configPda.toBase58());
        console.log(
            "Current on-chain lamports_per_pixel:",
            existingPrice === null ? "unknown" : existingPrice,
        );
        if (showOnly) return;
        console.log(
            "No initialize transaction sent (account already exists).",
        );
        return;
    }

    if (showOnly) {
        console.log("Config PDA is not initialized yet:", configPda.toBase58());
        return;
    }

    const data = Buffer.concat([
        discriminator("initialize"),
        treasury.toBuffer(),
        u64Le(lamportsPerPixel),
    ]);

    const ix = new web3.TransactionInstruction({
        programId,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: configPda, isSigner: false, isWritable: true },
            {
                pubkey: web3.SystemProgram.programId,
                isSigner: false,
                isWritable: false,
            },
        ],
        data,
    });

    const tx = new web3.Transaction().add(ix);
    let signature;
    try {
        signature = await web3.sendAndConfirmTransaction(connection, tx, [payer], {
            commitment: "confirmed",
        });
    } catch (err) {
        if (
            err?.message &&
            String(err.message).includes("Attempt to debit an account but found no record of a prior credit")
        ) {
            throw new Error(
                "Payer wallet has no funds on this cluster. Wallet: " +
                    payer.publicKey.toBase58(),
            );
        }
        throw err;
    }

    console.log("Initialize signature:", signature);
    console.log("Config PDA:", configPda.toBase58());
    console.log("Treasury:", treasury.toBase58());
    console.log("Lamports per pixel:", lamportsPerPixel);
}

main().catch((err) => {
    console.error("init-config failed:", err.message || err);
    process.exit(1);
});
