require("dotenv").config();
const mongoose = require("mongoose");
const Company = require("../src/models/company.model");
const User = require("../src/models/user.model");

// Bootstraps a tenant: one company plus the admin who will finish the setup
// wizard inside the app. Everything else on the company profile is filled in
// there, not here.
async function main() {
  const [, , companyName, username, password, name] = process.argv;

  if (!companyName || !username || !password) {
    console.error(
      'Usage: node scripts/create-company.js "<company name>" <username> <password> [admin full name]',
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

  const company = await Company.create({ name: companyName });

  try {
    const user = await User.create({
      company: company._id,
      username,
      password,
      name,
      role: "admin",
    });

    console.log(`Company created: ${company.name} (${company._id})`);
    console.log(`Admin created:   ${user.username}${user.name ? ` (${user.name})` : ""}`);
    console.log("Sign in and the app will walk this admin through onboarding.");
  } catch (error) {
    // Leave no orphan company behind if the admin could not be created.
    await Company.deleteOne({ _id: company._id });
    throw error;
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
