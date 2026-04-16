const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const maxSupply = ethers.parseUnits(process.env.MAX_SUPPLY || "1000000", 18);
  const mintPrice = process.env.MINT_PRICE_WEI_PER_COIN || "0";
  const treasury = process.env.TREASURY_ADDRESS || admin;

  const Token = await ethers.getContractFactory("TPCToken");
  const token = await Token.deploy(admin, maxSupply, mintPrice, treasury);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("TPCToken deployed to:", address);

  const authorizer = process.env.AUTHORIZER_ADDRESS;
  if (authorizer) {
    const role = await token.AUTHORIZER_ROLE();
    const tx = await token.grantRole(role, authorizer);
    await tx.wait();
    console.log("Granted AUTHORIZER_ROLE to:", authorizer);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
