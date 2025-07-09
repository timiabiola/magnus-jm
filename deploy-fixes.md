# Deployment Guide for Duplicate n8n Execution Fixes

## Steps to Deploy the Fixes

### 1. Apply Database Migration

First, you need to apply the database migration to your Supabase instance:

```bash
# Option A: Using Supabase CLI (if you have the project linked)
npx supabase db push

# Option B: Manual application via Supabase Dashboard
# 1. Go to your Supabase Dashboard
# 2. Navigate to SQL Editor
# 3. Copy and paste the contents of supabase/migrations/20250709000000-fix-duplicate-executions.sql
# 4. Run the SQL
```

### 2. Deploy the Edge Function

Deploy the updated webhook-proxy function:

```bash
# Deploy the edge function
npx supabase functions deploy webhook-proxy
```

### 3. Verify Deployment

After deployment, test the webhook to ensure it's working:

```bash
# Test the function (replace with your actual project URL and anon key)
curl -X POST https://wqtgghcxrhrszdbxkwoy.supabase.co/functions/v1/webhook-proxy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{
    "content": "Test message",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440001"
  }'
```

## Troubleshooting

If you're still getting errors:

1. **Check Edge Function Logs**:
   ```bash
   npx supabase functions logs webhook-proxy --tail
   ```

2. **Verify Database Migration**:
   - Check if the `generate_request_fingerprint` function exists with the new parameter
   - Check if the new columns were added to `webhook_requests` table

3. **Common Issues**:
   - Missing environment variables in Edge Function
   - Database migration not applied
   - Edge Function not deployed with latest changes

## What Changed

1. **Database Changes**:
   - Updated `generate_request_fingerprint` to use 30-second time windows
   - Added `processing_started_at`, `retry_count`, and `last_error` columns
   - Added cleanup function for stale requests

2. **Edge Function Changes**:
   - Fixed timeout implementation using AbortController
   - Added better error handling and logging
   - Improved duplicate detection logic

3. **Frontend Changes**:
   - Added message hash-based duplicate detection
   - 5-second window for preventing duplicate messages
   - Better error handling for duplicate requests 