require('dotenv').config();
const mongoose = require('mongoose');
const Admin    = require('./models/Admin');

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const exists = await Admin.findOne({ username: 'admin' });
  if (exists) {
    console.log('Admin already exists — skipping seed.');
    process.exit(0);
  }

  await Admin.create({
    username: process.env.SEED_ADMIN_USER ,
    password: process.env.SEED_ADMIN_PASS ,
    name:     'Thakur Admin',
  });

  console.log('✅ Admin created successfully!');
  console.log(`   Username : ${process.env.SEED_ADMIN_USER || 'admin'}`);
  console.log('   Password : (from .env SEED_ADMIN_PASS)');
  console.log('\n⚠️  Change the password after first login!');
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
