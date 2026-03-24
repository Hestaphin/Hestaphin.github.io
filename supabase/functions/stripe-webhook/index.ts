import { createClient } from 'npm:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=denonext'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-11-20',
})
const cryptoProvider = Stripe.createSubtleCryptoProvider()

async function findAuthUserByEmail(supabase: ReturnType<typeof createClient>, email: string) {
  let page = 1
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const found = data.users.find((user) => (user.email || '').toLowerCase() === email.toLowerCase())
    if (found) return found
    if (data.users.length < 1000) break
    page += 1
  }
  return null
}

Deno.serve(async (req) => {
  try {
    const signature = req.headers.get('Stripe-Signature')
    if (!signature) return new Response('Missing signature', { status: 400 })

    const body = await req.text()
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET') ?? '',
      undefined,
      cryptoProvider,
    )

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const requestId = session.metadata?.checkout_request_id
      if (!requestId) return new Response('Missing checkout_request_id', { status: 400 })

      const { data: checkoutRequest, error: requestError } = await supabase
        .from('membership_checkout_requests')
        .select('*')
        .eq('id', requestId)
        .single()
      if (requestError || !checkoutRequest) return new Response('Checkout request not found', { status: 400 })

      if (checkoutRequest.fulfilled_at) {
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      const email = String(checkoutRequest.email || session.customer_details?.email || '').trim().toLowerCase()
      if (!email) return new Response('Missing customer email', { status: 400 })

      let authUser = await findAuthUserByEmail(supabase, email)
      if (!authUser) {
        const invite = await supabase.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${Deno.env.get('SITE_URL') ?? ''}/membership/`,
        })
        if (invite.error) throw invite.error
        authUser = invite.data.user
      }
      if (!authUser) return new Response('Could not create membership user', { status: 400 })

      const { data: plan } = await supabase
        .from('membership_plans')
        .select('duration_months')
        .eq('id', checkoutRequest.plan_id)
        .single()

      const paidThrough = new Date()
      paidThrough.setMonth(paidThrough.getMonth() + (plan?.duration_months ?? 12))

      await supabase
        .from('profiles')
        .upsert({
          user_id: authUser.id,
          email,
          role: 'member',
          membership_tier: checkoutRequest.plan_name,
          membership_status: 'active',
          paid_through: paidThrough.toISOString(),
        })

      await supabase
        .from('membership_orders')
        .insert({
          user_id: authUser.id,
          plan_id: checkoutRequest.plan_id,
          plan_name: checkoutRequest.plan_name,
          amount_cents: checkoutRequest.amount_cents,
          currency: checkoutRequest.currency,
          payment_status: 'paid',
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          paid_at: new Date().toISOString(),
        })

      await supabase
        .from('membership_checkout_requests')
        .update({
          payment_status: 'paid',
          fulfilled_at: new Date().toISOString(),
          stripe_checkout_session_id: session.id,
        })
        .eq('id', checkoutRequest.id)
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object as Stripe.Checkout.Session
      const requestId = session.metadata?.checkout_request_id
      if (requestId) {
        await supabase
          .from('membership_checkout_requests')
          .update({ payment_status: 'cancelled', stripe_checkout_session_id: session.id })
          .eq('id', requestId)
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Unknown error', { status: 400 })
  }
})
