import { createClient } from 'npm:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-11-20',
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    const body = await req.json()
    const email = String(body.email || '').trim().toLowerCase()
    const planSlug = String(body.plan_slug || '')
    const returnUrl = String(body.return_url || '').replace(/\/$/, '')
    if (!email || !planSlug || !returnUrl) throw new Error('email, plan_slug, and return_url are required.')

    const { data: plan, error: planError } = await supabase
      .from('membership_plans')
      .select('*')
      .eq('slug', planSlug)
      .eq('active', true)
      .single()
    if (planError || !plan) throw new Error('Membership plan was not found.')

    const { data: requestRow, error: requestError } = await supabase
      .from('membership_checkout_requests')
      .insert({
        email,
        plan_id: plan.id,
        plan_name: plan.name,
        amount_cents: plan.price_cents,
        currency: plan.currency,
        payment_status: 'pending',
      })
      .select('*')
      .single()
    if (requestError || !requestRow) throw requestError ?? new Error('Could not create checkout request.')

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      success_url: `${returnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?checkout=cancel`,
      line_items: [{
        price: plan.stripe_price_id,
        quantity: 1,
      }],
      metadata: {
        checkout_request_id: requestRow.id,
        plan_slug: plan.slug,
        email,
      },
    })

    const { error: updateError } = await supabase
      .from('membership_checkout_requests')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', requestRow.id)
    if (updateError) throw updateError

    return Response.json({ url: session.url }, { headers: corsHeaders })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400, headers: corsHeaders })
  }
})
