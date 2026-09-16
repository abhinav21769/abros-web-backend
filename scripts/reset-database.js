require("dotenv").config();
const mongoose = require("mongoose");

// Destructive: drops every application collection so a deployment can restart
// on the multi-tenant schema with no untenanted rows left behind. Nothing runs
// without --yes, and production is refused outright.
const COLLECTIONS = [
  "companies",
  "users",
  "customers",
  "medicines",
  "invoices",
  "purchases",
  "stockledgers",
];

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "This deletes ALL data in the target database. Re-run with --yes to confirm.",
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production.");
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  const existing = (await db.listCollections().toArray()).map((c) => c.name);

  for (const name of COLLECTIONS) {
    if (existing.includes(name)) {
      // drop() removes the old indexes too - that matters here, because the
      // pre-tenant unique indexes on invoiceNumber and gstin would otherwise
      // survive and keep clashing across companies.
      await db.collection(name).drop();
      console.log(`dropped ${name}`);
    }
  }

  console.log(
    'Done. Create the first tenant with: npm run create-company -- "<company name>" <username> <password>',
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
