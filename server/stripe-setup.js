/**
 * Stripe Setup Script - Build 5
 *
 * Creates products and prices in Stripe with stable lookup keys.
 * Idempotent: safe to re-run without duplicating anything.
 *
 * Usage: node stripe-setup.js
 * Requires: STRIPE_SECRET_KEY and DATABASE_URL environment variables
 */

require('dotenv').config({ path: '../.env' });
const Stripe = require('stripe');
const { Pool } = require('pg');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const dbUrl = process.env.DATABASE_URL || '';
const isInternalRailway = dbUrl.includes('.railway.internal');
const pool = new Pool({
  connectionString: dbUrl,
  ssl: (!isInternalRailway && process.env.NODE_ENV === 'production') ? { rejectUnauthorized: false } : false,
});

// Plan definitions
const PLANS = [
  {
    id: 'team',
    name: 'Daily Reps - Team',
    description: 'For standalone teams. Up to 20 players.',
    cap: 20,
    monthly: 999,   // $9.99 in cents
    annual: 7999,   // $79.99 in cents
  },
  {
    id: 'small_club',
    name: 'Daily Reps - Small Club',
    description: 'For small clubs. Up to 200 players across unlimited teams.',
    cap: 200,
    monthly: 7499,   // $74.99
    annual: 64999,   // $649.99
  },
  {
    id: 'large_club',
    name: 'Daily Reps - Large Club',
    description: 'For large clubs. Up to 500 players across unlimited teams.',
    cap: 500,
    monthly: 17999,  // $179.99
    annual: 149999,  // $1,499.99
  },
  {
    id: 'mega_club',
    name: 'Daily Reps - Mega Club',
    description: 'For mega clubs. Up to 1,000 players across unlimited teams.',
    cap: 1000,
    monthly: 34999,  // $349.99
    annual: 289999,  // $2,899.99
  },
];

const ADDON = {
  id: 'addon_player',
  name: 'Daily Reps - Add-on Player',
  description: 'Add one additional player beyond your plan limit.',
  monthly: 59,    // $0.59
  annual: 499,    // $4.99
};

async function findOrCreateProduct(id, name, description) {
  // Search for existing product by metadata
  const existing = await stripe.products.search({
    query: `metadata['lookup_key']:'${id}'`,
  });

  if (existing.data.length > 0) {
    console.log(`  Product "${name}" already exists (${existing.data[0].id})`);
    return existing.data[0];
  }

  const product = await stripe.products.create({
    name,
    description,
    metadata: { lookup_key: id },
  });
  console.log(`  Created product "${name}" (${product.id})`);
  return product;
}

async function findOrCreatePrice(productId, lookupKey, unitAmount, interval) {
  // Check if price with this lookup key exists
  const existing = await stripe.prices.list({
    lookup_keys: [lookupKey],
  });

  if (existing.data.length > 0) {
    console.log(`    Price "${lookupKey}" already exists (${existing.data[0].id})`);
    return existing.data[0];
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: 'usd',
    recurring: { interval: interval === 'annual' ? 'year' : 'month' },
    lookup_key: lookupKey,
  });
  console.log(`    Created price "${lookupKey}" = $${(unitAmount / 100).toFixed(2)}/${interval} (${price.id})`);
  return price;
}

async function main() {
  console.log('=== Daily Reps Stripe Setup ===\n');

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY is not set.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const priceIds = {};

  // Create plan products and prices
  for (const plan of PLANS) {
    console.log(`\nPlan: ${plan.name}`);
    const product = await findOrCreateProduct(plan.id, plan.name, plan.description);

    const monthlyKey = `${plan.id}_monthly`;
    const annualKey = `${plan.id}_annual`;

    const monthlyPrice = await findOrCreatePrice(product.id, monthlyKey, plan.monthly, 'monthly');
    const annualPrice = await findOrCreatePrice(product.id, annualKey, plan.annual, 'annual');

    priceIds[monthlyKey] = monthlyPrice.id;
    priceIds[annualKey] = annualPrice.id;
  }

  // Create add-on product and prices
  console.log(`\nAdd-on: ${ADDON.name}`);
  const addonProduct = await findOrCreateProduct(ADDON.id, ADDON.name, ADDON.description);

  const addonMonthlyKey = 'addon_player_monthly';
  const addonAnnualKey = 'addon_player_annual';

  const addonMonthly = await findOrCreatePrice(addonProduct.id, addonMonthlyKey, ADDON.monthly, 'monthly');
  const addonAnnual = await findOrCreatePrice(addonProduct.id, addonAnnualKey, ADDON.annual, 'annual');

  priceIds[addonMonthlyKey] = addonMonthly.id;
  priceIds[addonAnnualKey] = addonAnnual.id;

  // Store price IDs in billing_config table
  console.log('\nStoring price IDs in billing_config...');
  for (const [key, value] of Object.entries(priceIds)) {
    await pool.query(
      `INSERT INTO billing_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
    console.log(`  ${key} = ${value}`);
  }

  console.log('\n=== Setup Complete ===');
  console.log(`\nCreated ${Object.keys(priceIds).length} prices across ${PLANS.length + 1} products.`);
  console.log('\nNext steps:');
  console.log('1. Register webhook endpoint in Stripe Dashboard:');
  console.log('   URL: https://<your-domain>/api/billing/webhook');
  console.log('   Events: checkout.session.completed, customer.subscription.created,');
  console.log('           customer.subscription.updated, customer.subscription.deleted,');
  console.log('           invoice.payment_failed, invoice.payment_succeeded,');
  console.log('           customer.subscription.trial_will_end');
  console.log('2. Copy the webhook signing secret to STRIPE_WEBHOOK_SECRET env var.');

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
