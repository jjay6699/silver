require("dotenv").config();
const { ethers } = require("ethers");
const { signMint } = require("../utils/mintSigner");

async function main() {
  const rpcUrl = process.env.MINT_RPC_URL;
  const privateKey = process.env.MINT_AUTHORIZER_PRIVATE_KEY;
  const contract = process.env.MINT_CONTRACT;
  const to = process.env.MINT_TO;
  const amount = process.env.MINT_AMOUNT;
  const deadline = process.env.MINT_DEADLINE;

  if (!rpcUrl || !privateKey || !contract || !to || !amount || !deadline) {
    throw new Error("Missing required env vars for signing");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const chain = await provider.getNetwork();
  const chainId = Number(chain.chainId);

  const abi = ["function nonces(address) view returns (uint256)"];
  const token = new ethers.Contract(contract, abi, provider);
  const nonce = await token.nonces(to);

  const signature = await signMint({
    privateKey,
    chainId,
    contractAddress: contract,
    to,
    amount: ethers.parseUnits(amount, 18),
    nonce,
    deadline: Number(deadline),
  });

  console.log(JSON.stringify({ to, amount, nonce: nonce.toString(), deadline, signature }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
