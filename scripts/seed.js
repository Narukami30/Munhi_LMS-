require('dotenv').config();

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  role: { type: String, required: true },
  identifier: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  active: { type: Boolean, default: true }
});
accountSchema.index({ role: 1, identifier: 1 }, { unique: true });
const Account = mongoose.model('Account', accountSchema);

async function seed() {
  const mongoUri = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://127.0.0.1:27017/naujan_mhs_serms');
  if (!mongoUri) throw new Error('MONGODB_URI is required in production. Set it to your MongoDB connection string.');
  await mongoose.connect(mongoUri);
  const accounts = [
    ['student', process.env.SEED_STUDENT_IDENTIFIER, process.env.SEED_STUDENT_EMAIL, process.env.SEED_STUDENT_PASSWORD, 'NMHS Learner'],
    ['teacher', process.env.SEED_TEACHER_IDENTIFIER, process.env.SEED_TEACHER_EMAIL, process.env.SEED_TEACHER_PASSWORD, 'NMHS Teacher'],
    ['registrar', process.env.SEED_REGISTRAR_IDENTIFIER, process.env.SEED_REGISTRAR_EMAIL, process.env.SEED_REGISTRAR_PASSWORD, 'NMHS Registrar'],
    ['principal', process.env.SEED_PRINCIPAL_IDENTIFIER, process.env.SEED_PRINCIPAL_EMAIL, process.env.SEED_PRINCIPAL_PASSWORD, 'NMHS Principal']
  ];
  let seededCount = 0;
  for (const [role, identifier, email, password, name] of accounts) {
    if (!identifier && !password) continue;
    if (!identifier || !password) throw new Error(`Both seed identifier and password are required for ${role}.`);
    if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      throw new Error(`The ${role} password must be at least 12 characters and include upper/lowercase letters, a number, and a symbol.`);
    }
    const normalizedIdentifier = identifier.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    await Account.updateOne(
      { role, identifier: normalizedIdentifier },
      { $set: { passwordHash, name, active: true, ...(email ? { email: email.trim().toLowerCase() } : normalizedIdentifier.includes('@') ? { email: normalizedIdentifier } : {}) } },
      { upsert: true }
    );
    console.log(`Seeded ${role} account: ${identifier}`);
    seededCount += 1;
  }
  if (!seededCount) throw new Error('Configure at least one role identifier and password in .env before seeding.');
}

seed()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
