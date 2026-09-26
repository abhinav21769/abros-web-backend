require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/user.model");

async function main() {
  const [, , username, password, name] = process.argv;

  if (!username || !password) {
    console.error(
      "Usage: node scripts/create-user.js <username> <password> [name]",
    );
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ username: username.toLowerCase() });
  if (existing) {
    console.error(`User "${username}" already exists.`);
    process.exit(1);
  }

  const user = await User.create({
    username,
    password,
    name,
  });

  console.log(
    `User created: ${user.username}${user.name ? ` (${user.name})` : ""}`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
