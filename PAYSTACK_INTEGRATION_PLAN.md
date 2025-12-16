# Paystack Payment Integration Plan

## Current State Analysis

### ✅ What's Already in Place:
1. **Package Installed**: `react-paystack@^6.0.0` is installed
2. **Component Imported**: `PaystackButton` is imported in `ClientPortal.tsx` (line 2) but **NOT USED**
3. **Payment Method UI**: Users can select "Pay Online" vs "Pay at Shop" (lines 513-547)
4. **Payment Status Tracking**: Booking model includes `paymentMethod` and `paymentStatus` fields
5. **Booking Creation**: Currently creates booking immediately regardless of payment method

### ❌ What's Missing:
1. **Environment Variable**: No Paystack public key configured (`VITE_PAYSTACK_PUBLIC_KEY`)
2. **Payment Flow**: Booking is created BEFORE payment (should be AFTER for online payments)
3. **PaystackButton Integration**: Component imported but never rendered
4. **Payment Callbacks**: No success/error handlers for payment completion
5. **Transaction Tracking**: No payment reference/transaction ID stored in booking
6. **Payment Status Updates**: No mechanism to update booking after successful payment

---

## Implementation Plan

### Phase 1: Environment Configuration ✅ (User Completed)
- [x] Add `VITE_PAYSTACK_PUBLIC_KEY` to `.env` file
- [ ] Verify key is accessible via `import.meta.env.VITE_PAYSTACK_PUBLIC_KEY`

### Phase 2: Update Booking Flow Logic
**Current Flow (WRONG for online payments):**
```
Select Payment → Create Booking → Show Success
```

**Correct Flow (for online payments):**
```
Select Payment → Show Paystack Button → Process Payment → Create Booking → Show Success
```

**For Cash Payments:**
```
Select Payment → Create Booking → Show Success (current flow is fine)
```

### Phase 3: Implement PaystackButton Integration

**Location**: `pages/ClientPortal.tsx` - Step 3 (Payment Options)

**Changes Needed:**
1. **Conditional Rendering**: 
   - If `paymentMethod === PaymentMethod.ONLINE`: Show PaystackButton instead of regular "Confirm Booking" button
   - If `paymentMethod === PaymentMethod.CASH`: Keep current flow

2. **Payment Configuration**:
   - Amount: `selectedService.price` (convert to kobo/cent if needed - Paystack uses smallest currency unit)
   - Email: Generate from client phone or use a placeholder
   - Reference: Generate unique reference (can use booking ID or UUID)
   - Public Key: From `import.meta.env.VITE_PAYSTACK_PUBLIC_KEY`

3. **Payment Callbacks**:
   - **onSuccess**: Create booking with `PaymentStatus.PAID`, store transaction reference
   - **onClose**: Show error message, allow retry
   - **onError**: Handle payment errors gracefully

### Phase 4: Update Booking Model (if needed)
**Check if Booking type needs:**
- `paymentReference?: string` - Store Paystack transaction reference
- `transactionId?: string` - Store Paystack transaction ID

**Current Booking interface** (from `types.ts`):
```typescript
interface Booking {
  // ... existing fields
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  // May need to add:
  // paymentReference?: string;
  // transactionId?: string;
}
```

### Phase 5: Modify handleBook Function
**Split into two functions:**
1. `handleCashBooking()` - Current logic (immediate booking creation)
2. `handleOnlinePayment()` - Trigger Paystack payment, create booking in success callback

**OR** refactor `handleBook()` to:
- Check payment method
- If CASH: Create booking immediately
- If ONLINE: Don't create booking yet, let PaystackButton handle it

### Phase 6: Payment Success Handler
**When payment succeeds:**
1. Extract transaction reference from Paystack response
2. Create booking with:
   - `paymentStatus: PaymentStatus.PAID`
   - `paymentReference: response.reference` (or similar)
3. Handle reschedule cancellation if applicable
4. Navigate to success screen (step 5)

### Phase 7: Error Handling
**Scenarios to handle:**
1. **Payment Cancelled**: User closes Paystack popup
   - Show message: "Payment was cancelled. Please try again."
   - Allow retry

2. **Payment Failed**: Paystack returns error
   - Show error message
   - Allow retry or switch to cash payment

3. **Network Issues**: Payment succeeds but booking creation fails
   - Show error: "Payment successful but booking failed. Contact support with reference: [ref]"
   - Store payment reference for manual reconciliation

4. **Missing Public Key**: Environment variable not set
   - Show error: "Payment system not configured. Please contact support."

### Phase 8: Currency Handling
**Important**: Paystack uses smallest currency unit
- South African Rand (ZAR): Amount in cents
- Example: R200 = 20000 kobo/cents
- Formula: `amount * 100` (convert to cents)

### Phase 9: Testing Checklist
- [ ] Test with Paystack test keys
- [ ] Test successful payment flow
- [ ] Test payment cancellation
- [ ] Test payment failure scenarios
- [ ] Test cash payment flow (should still work)
- [ ] Test reschedule with online payment
- [ ] Verify booking created with correct payment status
- [ ] Verify transaction reference stored
- [ ] Test with missing/invalid public key

---

## Code Structure Changes

### File: `pages/ClientPortal.tsx`

**New State Variables Needed:**
```typescript
const [paystackConfig, setPaystackConfig] = useState<any>(null);
const [isProcessingPayment, setIsProcessingPayment] = useState(false);
```

**Modified Functions:**
- `handleBook()` - Split logic based on payment method
- New: `handlePaymentSuccess()` - Create booking after payment
- New: `handlePaymentClose()` - Handle user cancellation
- New: `handlePaymentError()` - Handle payment errors

**Modified JSX (Step 3):**
- Conditionally render PaystackButton when ONLINE selected
- Hide regular "Confirm Booking" button when ONLINE selected
- Show payment processing state

### File: `types.ts` (Optional Enhancement)
```typescript
export interface Booking {
  // ... existing fields
  paymentReference?: string; // Paystack transaction reference
  transactionId?: string;     // Paystack transaction ID
}
```

---

## Implementation Steps (In Order)

1. ✅ **Verify .env file** has `VITE_PAYSTACK_PUBLIC_KEY`
2. **Add payment reference fields** to Booking type (optional but recommended)
3. **Refactor handleBook()** to check payment method
4. **Implement PaystackButton** in Step 3 UI
5. **Add payment callbacks** (onSuccess, onClose, onError)
6. **Update booking creation** to happen in payment success callback
7. **Add error handling** for all payment scenarios
8. **Test thoroughly** with Paystack test keys
9. **Update admin portal** to display payment references (optional)

---

## PaystackButton Configuration Example

```typescript
<PaystackButton
  publicKey={import.meta.env.VITE_PAYSTACK_PUBLIC_KEY}
  email={`${client.phone}@waylans.local`} // or use client email if available
  amount={selectedService.price * 100} // Convert to cents
  reference={uuidv4()} // Generate unique reference
  text="Pay Now"
  onSuccess={(response) => handlePaymentSuccess(response)}
  onClose={() => handlePaymentClose()}
  className="w-full"
/>
```

---

## Notes

- **Currency**: Ensure Paystack account is configured for ZAR (South African Rand)
- **Test Mode**: Use test public key during development
- **Live Mode**: Switch to live public key for production
- **Email**: Paystack requires email. Can use phone-based email or collect email in login step
- **Reference**: Must be unique per transaction. UUID is recommended.

---

## Risk Mitigation

1. **Double Booking**: If payment succeeds but booking creation fails, user might pay twice
   - **Solution**: Store payment reference, check for duplicates before creating booking

2. **Slot Taken**: Time between payment and booking creation could allow slot to be booked
   - **Solution**: Create booking with PENDING status first, then update to PAID after payment (or use transaction locks)

3. **Payment Succeeds, Booking Fails**: User paid but no booking created
   - **Solution**: Store payment reference, allow admin to manually create booking

---

## Estimated Implementation Time

- **Phase 1**: ✅ Complete (user done)
- **Phase 2-7**: 2-3 hours
- **Phase 8-9**: 1-2 hours
- **Total**: ~3-5 hours

