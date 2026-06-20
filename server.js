const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const FLW_SECRET = process.env.FLW_SECRET;
const SMEPLUG_KEY = process.env.SMEPLUG_KEY;
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP || '2347086010672';

// Simple file-based order database
const DB_FILE = 'orders.json';
function getOrders() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return []; }
}
function saveOrder(order) {
  const orders = getOrders();
  orders.push(order);
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

// ── VERIFY FLUTTERWAVE PAYMENT ──
app.post('/verify-payment', async (req, res) => {
  try {
    const { transaction_id, order } = req.body;
    if (!transaction_id) return res.json({ success: false, message: 'No transaction ID' });

    // Verify with Flutterwave
    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET}` } }
    );

    const data = response.data.data;

    if (data.status === 'successful' && data.amount >= order.amount && data.currency === 'NGN') {
      // Check duplicate payment
      const orders = getOrders();
      const duplicate = orders.find(o => o.transaction_id === String(transaction_id));
      if (duplicate) {
        return res.json({ success: false, message: 'Duplicate transaction' });
      }

      // Save order
      const newOrder = {
        ...order,
        transaction_id: String(transaction_id),
        status: 'paid',
        timestamp: new Date().toISOString(),
        flw_ref: data.flw_ref
      };
      saveOrder(newOrder);

      // Deliver service
      let deliveryResult = { success: false, message: 'Manual delivery required' };

      if (order.type === 'data') {
        deliveryResult = await sendData(order);
      } else if (order.type === 'airtime') {
        deliveryResult = await sendAirtime(order);
      }

      // Update order status
      const allOrders = getOrders();
      const idx = allOrders.findIndex(o => o.transaction_id === String(transaction_id));
      if (idx !== -1) {
        allOrders[idx].delivery = deliveryResult;
        allOrders[idx].status = deliveryResult.success ? 'delivered' : 'pending_manual';
        fs.writeFileSync(DB_FILE, JSON.stringify(allOrders, null, 2));
      }

      res.json({ success: true, delivery: deliveryResult, order: newOrder });
    } else {
      res.json({ success: false, message: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Verify error:', err.message);
    res.json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── SEND DATA via Smeplug ──
async function sendData(order) {
  try {
    if (!order.networkId || !order.planId) {
      return { success: false, message: 'Missing network or plan ID' };
    }

    const response = await axios.post(
      'https://smeplug.ng/api/v1/data/purchase',
      {
        network_id: order.networkId,
        phone: order.phone,
        plan_id: order.planId,
        ref: `GDL_${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${SMEPLUG_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status === true || response.data.status === 'success') {
      return { success: true, message: 'Data delivered!', ref: response.data.ident || response.data.reference };
    } else {
      return { success: false, message: response.data.message || 'Delivery failed' };
    }
  } catch (err) {
    return { success: false, message: 'Smeplug error: ' + (err.response?.data?.message || err.message) };
  }
}

// ── SEND AIRTIME via Smeplug ──
async function sendAirtime(order) {
  try {
    if (!order.networkId) {
      return { success: false, message: 'Missing network ID' };
    }

    const response = await axios.post(
      'https://smeplug.ng/api/v1/airtime/purchase',
      {
        network_id: order.networkId,
        phone: order.phone,
        amount: order.amount,
        ref: `GDL_AIR_${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${SMEPLUG_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status === true || response.data.status === 'success') {
      return { success: true, message: 'Airtime delivered!', ref: response.data.ident || response.data.reference };
    } else {
      return { success: false, message: response.data.message || 'Airtime delivery failed' };
    }
  } catch (err) {
    return { success: false, message: 'Airtime error: ' + (err.response?.data?.message || err.message) };
  }
}

// ── GET ORDERS (Admin) ──
app.get('/orders', (req, res) => {
  const orders = getOrders();
  res.json({ success: true, orders: orders.slice(-50).reverse() });
});

// ── GET SMEPLUG NETWORKS (to find real network_id values) ──
app.get('/networks', async (req, res) => {
  try {
    const response = await axios.get('https://smeplug.ng/api/v1/networks', {
      headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── GET SMEPLUG DATA PLANS (to find real plan_id values) ──
app.get('/data-plans', async (req, res) => {
  try {
    const response = await axios.get('https://smeplug.ng/api/v1/data/plans', {
      headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── GET ORGANIZED/CATEGORIZED DATA PLANS (cleaner format for shop.html) ──
app.get('/data-plans-organized', async (req, res) => {
  try {
    const [networksRes, plansRes] = await Promise.all([
      axios.get('https://smeplug.ng/api/v1/networks', {
        headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
      }),
      axios.get('https://smeplug.ng/api/v1/data/plans', {
        headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
      })
    ]);

    const networks = networksRes.data.networks; // { "1": "MTN", "2": "Airtel", ... }
    const plansByNetwork = plansRes.data.data; // { "1": [...], "2": [...] }

    const organized = {};

    for (const [netId, netName] of Object.entries(networks)) {
      const plans = plansByNetwork[netId] || [];

      // Categorize each plan by tag in its name
      const categorized = { SME: [], Gifting: [], Corporate: [], Other: [] };

      plans.forEach(plan => {
        const name = plan.name || '';
        const price = parseFloat(plan.price) || 0;
        if (price <= 0) return; // skip plans with no valid price

        const planData = { id: plan.id, name: name, price: price };

        if (/\[Corporate\]/i.test(name)) {
          categorized.Corporate.push(planData);
        } else if (/\[Gifting\]/i.test(name)) {
          categorized.Gifting.push(planData);
        } else if (/\[SME\]/i.test(name) || /Awoof/i.test(name)) {
          categorized.SME.push(planData);
        } else {
          categorized.Other.push(planData);
        }
      });

      // Sort each category by price ascending, limit to reasonable count
      Object.keys(categorized).forEach(cat => {
        categorized[cat].sort((a, b) => a.price - b.price);
      });

      organized[netId] = { name: netName, plans: categorized };
    }

    res.json({ success: true, networks: organized });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── GET SMEPLUG BALANCE ──
app.get('/balance', async (req, res) => {
  try {
    const response = await axios.get('https://smeplug.ng/api/v1/account/balance', {
      headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── WEBHOOK (Flutterwave) — Auto-fires when payment completes, even if browser closed ──
app.post('/webhook', async (req, res) => {
  try {
    const secretHash = process.env.FLW_WEBHOOK_SECRET;
    const signature = req.headers['verif-hash'];

    // Verify the webhook is genuinely from Flutterwave
    if (!signature || signature !== secretHash) {
      console.log('Webhook rejected: invalid signature');
      return res.status(401).end();
    }

    // Acknowledge receipt immediately (Flutterwave requires fast response)
    res.status(200).json({ status: 'received' });

    const payload = req.body;
    console.log('Webhook received:', JSON.stringify(payload));

    // Only process successful charge events
    if (payload.event !== 'charge.completed' || payload.data?.status !== 'successful') {
      return;
    }

    const transaction_id = payload.data.id;
    const tx_ref = payload.data.tx_ref;
    const amount = payload.data.amount;

    // Check if we already processed this transaction (avoid duplicate from both
    // the browser callback AND the webhook firing for the same payment)
    const orders = getOrders();
    const existing = orders.find(o => o.transaction_id === String(transaction_id));
    if (existing) {
      console.log('Webhook: transaction already processed, skipping', transaction_id);
      return;
    }

    // Re-verify with Flutterwave API directly (never trust webhook payload alone)
    const verifyRes = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET}` } }
    );
    const data = verifyRes.data.data;

    if (data.status !== 'successful' || data.currency !== 'NGN') {
      console.log('Webhook: verification failed for', transaction_id);
      return;
    }

    // Reconstruct order details from the meta/customer data sent during checkout
    // (the tx_ref encodes our order; full order data was also sent via narration/meta if available)
    const customer = data.customer || {};
    const meta = data.meta || {};

    const order = {
      type: meta.type || 'unknown',
      networkId: meta.networkId,
      planId: meta.planId,
      networkName: meta.networkName,
      planName: meta.planName,
      phone: meta.phone || customer.phone_number,
      provider: meta.provider,
      package: meta.package,
      decoder: meta.decoder,
      disco: meta.disco,
      meter: meta.meter,
      meterType: meta.meterType,
      email: customer.email,
      name: customer.name,
      amount: data.amount
    };

    const newOrder = {
      ...order,
      transaction_id: String(transaction_id),
      tx_ref,
      status: 'paid',
      source: 'webhook',
      timestamp: new Date().toISOString(),
      flw_ref: data.flw_ref
    };
    saveOrder(newOrder);

    // Attempt delivery
    let deliveryResult = { success: false, message: 'Manual delivery required' };
    if (order.type === 'data' && order.networkId && order.planId) {
      deliveryResult = await sendData(order);
    } else if (order.type === 'airtime' && order.networkId) {
      deliveryResult = await sendAirtime(order);
    }

    // Update order with delivery result
    const allOrders = getOrders();
    const idx = allOrders.findIndex(o => o.transaction_id === String(transaction_id));
    if (idx !== -1) {
      allOrders[idx].delivery = deliveryResult;
      allOrders[idx].status = deliveryResult.success ? 'delivered' : 'pending_manual';
      fs.writeFileSync(DB_FILE, JSON.stringify(allOrders, null, 2));
    }

    console.log('Webhook: order processed', transaction_id, deliveryResult);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`G DATA LINK Server running on port ${PORT}`));
