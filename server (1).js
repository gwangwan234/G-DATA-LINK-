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
    // Map network names to Smeplug network IDs
    const networkMap = {
      'MTN': 'mtn', 'Airtel': 'airtel', 'Glo': 'glo', '9mobile': '9mobile',
      'Airtel SME': 'airtel', 'Corporate': 'airtel', 'Gifting': 'airtel'
    };

    // Map data types to Smeplug plan types
    const typeMap = {
      'Airtel SME': 'SME', 'Corporate': 'CORPORATE',
      'Gifting': 'GIFTING', 'MTN': 'SME', 'Glo': 'SME', '9mobile': 'SME'
    };

    const network = networkMap[order.network] || 'airtel';
    const planType = typeMap[order.dataType] || 'SME';

    const response = await axios.post(
      'https://smeplug.com.ng/api/v1/data/purchase',
      {
        network: network,
        phone: order.phone,
        data_plan: order.planCode || order.size,
        bypass: false,
        "request-id": `GDL_${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${SMEPLUG_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status === true || response.data.status === 'success') {
      return { success: true, message: 'Data delivered!', ref: response.data.ident };
    } else {
      return { success: false, message: response.data.message || 'Delivery failed' };
    }
  } catch (err) {
    return { success: false, message: 'Smeplug error: ' + err.message };
  }
}

// ── SEND AIRTIME via Smeplug ──
async function sendAirtime(order) {
  try {
    const networkMap = { 'MTN': 'mtn', 'Airtel': 'airtel', 'Glo': 'glo', '9mobile': '9mobile' };
    const network = networkMap[order.network] || 'mtn';

    const response = await axios.post(
      'https://smeplug.com.ng/api/v1/airtime/purchase',
      {
        network: network,
        phone: order.phone,
        amount: order.amount,
        airtime_type: 'VTU',
        "request-id": `GDL_AIR_${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${SMEPLUG_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status === true || response.data.status === 'success') {
      return { success: true, message: 'Airtime delivered!', ref: response.data.ident };
    } else {
      return { success: false, message: response.data.message || 'Airtime delivery failed' };
    }
  } catch (err) {
    return { success: false, message: 'Airtime error: ' + err.message };
  }
}

// ── GET ORDERS (Admin) ──
app.get('/orders', (req, res) => {
  const orders = getOrders();
  res.json({ success: true, orders: orders.slice(-50).reverse() });
});

// ── GET SMEPLUG BALANCE ──
app.get('/balance', async (req, res) => {
  try {
    const response = await axios.get('https://smeplug.com.ng/api/v1/balance', {
      headers: { 'Authorization': `Bearer ${SMEPLUG_KEY}` }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── WEBHOOK (Flutterwave) ──
app.post('/webhook', (req, res) => {
  const secretHash = process.env.FLW_WEBHOOK_SECRET;
  const signature = req.headers['verif-hash'];
  if (signature !== secretHash) return res.status(401).end();
  console.log('Webhook received:', req.body);
  res.status(200).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`G DATA LINK Server running on port ${PORT}`));
