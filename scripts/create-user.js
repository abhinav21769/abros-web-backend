require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/user.model");
const Company = require("../src/models/company.model");

async function main() {
  const [, , username, password, name, roleArg, companyArg] = process.argv;

  if (!username || !password) {
    console.error(
      'Usage: node scripts/create-user.js <username> <password> [name] [admin|viewer] [company name or id]',
    );
    console.error(
      "The company may be omitted only when exactly one company exists.",
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

  // Every user belongs to a company. With one company on the deployment the
  // argument can be left off; past that it has to be named so a user is never
  // put into the wrong tenant by accident.
  let company;
  if (companyArg) {
    company = mongoose.isValidObjectId(companyArg)
      ? await Company.findById(companyArg)
      : await Company.findOne({ name: companyArg });

    if (!company) {
      console.error(`Company "${companyArg}" not found.`);
      process.exit(1);
    }
  } else {
    const companies = await Company.find().limit(2);
    if (companies.length !== 1) {
      console.error(
        companies.length === 0
          ? "No company exists yet. Run: npm run create-company -- \"<company name>\" <username> <password>"
          : "Several companies exist - pass the company name or id as the last argument.",
      );
      process.exit(1);
    }
    [company] = companies;
  }

  const role = roleArg === "admin" ? "admin" : roleArg === "viewer" ? "viewer" : "viewer";

  const user = await User.create({
    company: company._id,
    username,
    password,
    name,
    role,
  });

  console.log(
    `User created: ${user.username}${user.name ? ` (${user.name})` : ""} - ${user.role} at ${company.name}`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
