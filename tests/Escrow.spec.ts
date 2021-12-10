import * as anchor from "@project-serum/anchor";
import { Program, web3 } from "@project-serum/anchor";
import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { assert } from "chai";
import { Escrow } from "../target/types/escrow";

const { Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } =
  web3;

describe("Escrow", () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Escrow as Program<Escrow>;

  let mintA: Token;
  let mintB: Token;
  let initializerTokenAccountA: InstanceType<typeof PublicKey>;
  let initializerTokenAccountB: InstanceType<typeof PublicKey>;
  let takerTokenAccountA: InstanceType<typeof PublicKey>;
  let takerTokenAccountB: InstanceType<typeof PublicKey>;
  let vault_account_pda: InstanceType<typeof PublicKey>;
  let vault_account_bump: number;
  let vault_authority_pda: InstanceType<typeof PublicKey>;

  const takerAmount = 1000;
  const initializerAmount = 500;

  const escrowAccount = Keypair.generate();
  const payer = Keypair.generate();
  const mintAuthority = Keypair.generate();
  const initializerMainAccount = Keypair.generate();
  const takerMainAccount = Keypair.generate();

  it("Initialise escrow state", async () => {
    // Airdropping tokens to a payer.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 1e10),
      "confirmed"
    );

    // Fund Main Accounts
    await provider.send(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: 1e9,
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: takerMainAccount.publicKey,
            lamports: 1e9,
          })
        );
        return tx;
      })(),
      [payer]
    );

    mintA = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    mintB = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    initializerTokenAccountA = await mintA.createAccount(
      initializerMainAccount.publicKey
    );
    takerTokenAccountA = await mintA.createAccount(takerMainAccount.publicKey);

    initializerTokenAccountB = await mintB.createAccount(
      initializerMainAccount.publicKey
    );
    takerTokenAccountB = await mintB.createAccount(takerMainAccount.publicKey);

    await mintA.mintTo(
      initializerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      initializerAmount
    );

    await mintB.mintTo(
      takerTokenAccountB,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    const _initializerTokenAccountA = await mintA.getAccountInfo(
      initializerTokenAccountA
    );
    const _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);

    assert.ok(
      _initializerTokenAccountA.amount.toNumber() === initializerAmount
    );
    assert.ok(_takerTokenAccountB.amount.toNumber() === takerAmount);
  });

  it("Initialize escrow", async () => {
    const [_vault_account_pda, _vault_account_bump] =
      await PublicKey.findProgramAddress(
        [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed"))],
        program.programId
      );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    // const [_vault_authority_pda, _vault_authority_bump] =
    const [_vault_authority_pda] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow"))],
      program.programId
    );
    vault_authority_pda = _vault_authority_pda;

    await program.rpc.initializeEscrow(
      vault_account_bump,
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          vaultAccount: vault_account_pda,
          mint: mintA.publicKey,
          initializerDepositTokenAccount: initializerTokenAccountA,
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, initializerMainAccount],
      }
    );

    const _vault = await mintA.getAccountInfo(vault_account_pda);

    const _escrowAccount = await program.account.escrowAccount.fetch(
      escrowAccount.publicKey
    );

    // Check that the new owner is the PDA.
    assert.ok(_vault.owner.equals(vault_authority_pda));

    // Check that the values in the escrow account match what we expect.
    assert.ok(
      _escrowAccount.initializerKey.equals(initializerMainAccount.publicKey)
    );
    assert.ok(
      _escrowAccount.initializerAmount.toNumber() === initializerAmount
    );
    assert.ok(_escrowAccount.takerAmount.toNumber() === takerAmount);
    assert.ok(
      _escrowAccount.initializerDepositTokenAccount.equals(
        initializerTokenAccountA
      )
    );
    assert.ok(
      _escrowAccount.initializerReceiveTokenAccount.equals(
        initializerTokenAccountB
      )
    );
  });

  it("Exchange escrow", async () => {
    await program.rpc.exchange({
      accounts: {
        taker: takerMainAccount.publicKey,
        takerDepositTokenAccount: takerTokenAccountB,
        takerReceiveTokenAccount: takerTokenAccountA,
        initializerDepositTokenAccount: initializerTokenAccountA,
        initializerReceiveTokenAccount: initializerTokenAccountB,
        initializer: initializerMainAccount.publicKey,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [takerMainAccount],
    });

    const _takerTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);
    const _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);
    const _initializerTokenAccountA = await mintA.getAccountInfo(
      initializerTokenAccountA
    );
    const _initializerTokenAccountB = await mintB.getAccountInfo(
      initializerTokenAccountB
    );

    // TODO: Assert if the PDA token account is closed

    assert.ok(_takerTokenAccountA.amount.toNumber() === initializerAmount);
    assert.ok(_initializerTokenAccountA.amount.toNumber() === 0);
    assert.ok(_initializerTokenAccountB.amount.toNumber() === takerAmount);
    assert.ok(_takerTokenAccountB.amount.toNumber() === 0);
  });

  it("Initialize escrow and cancel escrow", async () => {
    // Put back tokens into initializer token A account.
    await mintA.mintTo(
      initializerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      initializerAmount
    );

    await program.rpc.initializeEscrow(
      vault_account_bump,
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          vaultAccount: vault_account_pda,
          mint: mintA.publicKey,
          initializerDepositTokenAccount: initializerTokenAccountA,
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, initializerMainAccount],
      }
    );

    // Cancel the escrow.
    await program.rpc.cancelEscrow({
      accounts: {
        initializer: initializerMainAccount.publicKey,
        initializerDepositTokenAccount: initializerTokenAccountA,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        escrowAccount: escrowAccount.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [initializerMainAccount],
    });

    // TODO: Assert if the PDA token account is closed

    // Check the final owner should be the provider public key.
    const _initializerTokenAccountA = await mintA.getAccountInfo(
      initializerTokenAccountA
    );
    assert.ok(
      _initializerTokenAccountA.owner.equals(initializerMainAccount.publicKey)
    );

    // Check all the funds are still there.
    assert.ok(
      _initializerTokenAccountA.amount.toNumber() === initializerAmount
    );
  });
});
