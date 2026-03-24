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
    if (meError || me?.role !== 'admin') throw new Error('Only administrators can delete internal accounts.')

    const body = await req.json()
    const targetUserId = String(body.user_id || '')
    if (!targetUserId) throw new Error('Missing user_id.')
    if (targetUserId === user.id) throw new Error('Administrators cannot delete themselves.')

    const { data: target, error: targetError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('user_id', targetUserId)
      .single()
    if (targetError) throw new Error('Target account was not found.')
    if (target.role !== 'internal') throw new Error('Only non-admin internal accounts can be deleted.')

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(targetUserId)
    if (deleteError) throw deleteError

    return Response.json({ ok: true }, { headers: corsHeaders })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400, headers: corsHeaders })
  }
})
