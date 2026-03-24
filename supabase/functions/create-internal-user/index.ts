import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header.')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()
    if (userError || !user) throw new Error('Invalid login session.')

    const { data: me, error: meError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()
    if (meError || me?.role !== 'admin') throw new Error('Only administrators can create internal accounts.')

    const body = await req.json()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const fullName = String(body.full_name || '').trim()

    if (!email || !password || password.length < 8) {
      throw new Error('Email and password are required, and the password must be at least 8 characters long.')
    }

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (createError) throw createError

    const createdUser = created.user
    if (!createdUser) throw new Error('User creation failed.')

    const { error: insertError } = await adminClient.from('profiles').insert({
      user_id: createdUser.id,
      email,
      full_name: fullName,
      role: 'internal',
    })
    if (insertError) {
      await adminClient.auth.admin.deleteUser(createdUser.id)
      throw insertError
    }

    return Response.json({ ok: true, user_id: createdUser.id }, { headers: corsHeaders })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400, headers: corsHeaders })
  }
})
