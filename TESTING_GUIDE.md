# Paystack Payment Testing Guide

## Step 1: Get Paystack Test Keys

### Option A: If you already have a Paystack account
1. Go to [Paystack Dashboard](https://dashboard.paystack.com/)
2. Log in to your account
3. Navigate to **Settings** → **API Keys & Webhooks**
4. Copy your **Test Public Key** (starts with `pk_test_...`)

### Option B: If you don't have a Paystack account
1. Sign up at [paystack.com](https://paystack.com/)
2. Complete the registration
3. Go to **Settings** → **API Keys & Webhooks**
4. Copy your **Test Public Key** (starts with `pk_test_...`)

---

## Step 2: Configure Environment Variable

1. Open your `.env` file in the project root
2. Add or update the Paystack public key:

```env
VITE_PAYSTACK_PUBLIC_KEY=pk_test_your_test_public_key_here
```

**Important**: 
- Replace `pk_test_your_test_public_key_here` with your actual test public key
- Make sure there are no spaces or quotes around the key
- The key should start with `pk_test_`

3. **Restart your development server** after updating `.env`:
   ```bash
   # Stop the server (Ctrl+C) and restart
   npm run dev
   ```

---

## Step 3: Start the Application

```bash
npm run dev
```

The app should start on `http://localhost:5173` (or the port Vite assigns).

---

## Step 4: Test the Payment Flow

### Basic Payment Test

1. **Navigate to Client Portal**
   - Go to `http://localhost:5173/#/client`
   - Or click "Return to Booking Portal" from admin

2. **Login/Register**
   - Enter your name
   - Enter a valid SA phone number (e.g., `0821234567`)
   - Click "Continue"

3. **Select Service**
   - Choose any service from the list
   - Click "Continue"

4. **Select Date & Time**
   - Pick an available date
   - Select an available time slot
   - Click "Continue"

5. **Select Payment Method**
   - You should see two options:
     - "Pay Online" (with Paystack logo)
     - "Pay at Shop"
   - **Click "Pay Online"**
   - The PaystackButton should appear below

6. **Test Payment**
   - Click the "Pay Now" button
   - Paystack popup should open
   - Use Paystack test card details (see below)

---

## Step 5: Paystack Test Cards

Use these test card numbers in the Paystack popup:

### ✅ Successful Payment
```
Card Number: 4084 0840 8408 4081
CVV: Any 3 digits (e.g., 408)
Expiry: Any future date (e.g., 12/25)
PIN: Any 4 digits (e.g., 0000)
OTP: Any 6 digits (e.g., 123456)
```

### ❌ Failed Payment (to test error handling)
```
Card Number: 5060 6666 6666 6666 6666
CVV: Any 3 digits
Expiry: Any future date
```

### 💳 3D Secure Test
```
Card Number: 4084 0840 8408 4081
CVV: Any 3 digits
Expiry: Any future date
PIN: Any 4 digits
OTP: Any 6 digits
```

---

## Step 6: What to Verify

### ✅ Successful Payment Test

1. **Payment Popup Opens**
   - Paystack payment form should appear
   - Form should show correct amount (in Rand)

2. **Complete Payment**
   - Enter test card details
   - Complete the payment flow
   - Popup should close automatically

3. **Booking Created**
   - Should navigate to success screen
   - Should show "Confirmed" message
   - Payment status should show "PAID" (green badge)
   - Booking should appear in "My Bookings"

4. **Check Booking Details**
   - Go to "My Bookings"
   - Verify booking shows:
     - Correct date and time
     - Service name
     - Amount
     - Status: "PAID"

5. **Check Admin Portal** (Optional)
   - Go to `/admin`
   - Login with password: `1234`
   - Check bookings list
   - Verify payment status shows "Paid"
   - Verify payment reference is stored (if visible)

### ❌ Payment Cancellation Test

1. **Start Payment**
   - Select "Pay Online"
   - Click "Pay Now"
   - Paystack popup opens

2. **Cancel Payment**
   - Click the "X" or close button
   - Popup should close

3. **Verify Error Message**
   - Should see error message: "Payment was cancelled. Please try again or select 'Pay at Shop'."
   - Should still be on Step 3
   - Can retry or switch to cash payment

### ❌ Payment Error Test

1. **Use Failed Card**
   - Select "Pay Online"
   - Click "Pay Now"
   - Enter failed test card: `5060 6666 6666 6666 6666`

2. **Verify Error Handling**
   - Should show error message
   - Should allow retry
   - Can switch to cash payment

### ✅ Cash Payment Test (Regression)

1. **Select Cash Payment**
   - Go through booking flow
   - On Step 3, select "Pay at Shop"
   - Click "Confirm Booking"

2. **Verify**
   - Booking created immediately
   - Status shows "NOT_PAID"
   - Success screen appears
   - No Paystack popup

---

## Step 7: Test Edge Cases

### Missing Public Key Test

1. **Temporarily remove/comment out** the public key in `.env`:
   ```env
   # VITE_PAYSTACK_PUBLIC_KEY=pk_test_...
   ```

2. **Restart server** and test:
   - Select "Pay Online"
   - Should see warning: "Payment system not configured. Please contact support or select 'Pay at Shop'."
   - PaystackButton should not appear

3. **Restore the key** after testing

### Reschedule with Online Payment

1. **Create a booking** (can use cash for speed)
2. **Go to "My Bookings"**
3. **Click "Reschedule"**
4. **Select new date/time**
5. **Select "Pay Online"**
6. **Complete payment**
7. **Verify**:
   - New booking created with PAID status
   - Old booking cancelled

---

## Step 8: Check Browser Console

Open browser DevTools (F12) and check:

1. **No Errors**
   - Console should be clean (no red errors)
   - Warnings are okay

2. **Payment Callbacks**
   - Should see payment success/error logs
   - Check Network tab for Paystack API calls

3. **Booking Creation**
   - Should see Firebase/Firestore writes
   - No connection errors

---

## Step 9: Verify Database

### Check Firebase/Firestore (if accessible)

1. **Go to Firebase Console**
2. **Navigate to Firestore Database**
3. **Check `bookings` collection**
4. **Verify new booking has**:
   - `paymentMethod: "Online (Paystack)"`
   - `paymentStatus: "Paid"`
   - `paymentReference: "WAYLANS-..."` (if implemented)
   - `transactionId: "..."` (if implemented)

---

## Common Issues & Solutions

### Issue: PaystackButton doesn't appear

**Check:**
- ✅ `.env` file has `VITE_PAYSTACK_PUBLIC_KEY` set
- ✅ Server was restarted after updating `.env`
- ✅ All booking details are selected (service, date, time, payment method)
- ✅ Check browser console for errors

**Solution:**
- Restart dev server: `npm run dev`
- Clear browser cache
- Check `.env` file format (no quotes, no spaces)

### Issue: Payment popup doesn't open

**Check:**
- ✅ Public key is correct (starts with `pk_test_`)
- ✅ No browser popup blockers
- ✅ Check browser console for errors

**Solution:**
- Disable popup blockers
- Try incognito/private window
- Check Paystack dashboard for account status

### Issue: Payment succeeds but booking not created

**Check:**
- ✅ Firebase connection
- ✅ Browser console for errors
- ✅ Network tab for failed API calls

**Solution:**
- Check Firebase configuration
- Verify internet connection
- Check error message (should show payment reference)

### Issue: Amount is wrong

**Check:**
- ✅ Service price in admin settings
- ✅ Amount shown in Paystack popup (should be in Rand, not cents)

**Note:** Amount sent to Paystack is in cents (price × 100), but Paystack displays it in Rand.

---

## Quick Test Checklist

- [ ] PaystackButton appears when "Pay Online" selected
- [ ] PaystackButton hidden when "Pay at Shop" selected
- [ ] Regular "Confirm Booking" button hidden when online payment selected
- [ ] Payment popup opens when clicking "Pay Now"
- [ ] Test card payment succeeds
- [ ] Booking created with PAID status after payment
- [ ] Payment reference stored in booking
- [ ] Success screen shows correct details
- [ ] Payment cancellation shows error message
- [ ] Cash payment still works (regression)
- [ ] Missing public key shows warning
- [ ] Reschedule with online payment works

---

## Testing with Live Keys (Production)

**⚠️ Only test with live keys when ready for production!**

1. Get **Live Public Key** from Paystack dashboard (starts with `pk_live_...`)
2. Update `.env`:
   ```env
   VITE_PAYSTACK_PUBLIC_KEY=pk_live_your_live_public_key_here
   ```
3. Restart server
4. Test with real card (small amount recommended)
5. Verify in Paystack dashboard that transaction appears

---

## Need Help?

- **Paystack Documentation**: https://paystack.com/docs
- **Paystack Support**: support@paystack.com
- **Test Cards**: https://paystack.com/docs/payments/test-payments

---

## Next Steps After Testing

Once testing is complete:
1. ✅ Verify all test cases pass
2. ✅ Document any issues found
3. ✅ Switch to live keys for production
4. ✅ Set up webhooks (optional, for server-side verification)
5. ✅ Configure email receipts (optional)

