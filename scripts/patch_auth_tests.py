import sys

content = open('auth-service/tests/auth.test.js', 'rb').read()

# Find the exact marker line
idx = content.find(b'imported real accounts')
start = content.rfind(b'\n', 0, idx - 5) + 1
end = content.find(b'\n', idx) + 1
marker_line = content[start:end]
print('marker_line:', repr(marker_line[:60]))

new_tests = (
    b'\n'
    b'  // \xe2\x94\x80\xe2\x94\x80 Email verification \xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
    b"  console.log('\\nEmail verification');\n"
    b'\n'
    b'  // Direct-SQL helper: creates a user without going through the rate-limited\n'
    b'  // /auth/register endpoint. Uses bcrypt cost 4 (minimum) for test speed.\n'
    b'  async function insertTestUser(email, verified = false) {\n'
    b"    const hash = await bcryptjs.hash('TestPass1!', 4);\n"
    b'    const { rows } = await pool.query(\n'
    b'      `INSERT INTO users (name, email, password_hash, role, email_verified)\n'
    b"       VALUES ('Test', $1, $2, 'buyer', $3) RETURNING id, email`,\n"
    b'      [email, hash, verified]\n'
    b'    );\n'
    b'    return rows[0];\n'
    b'  }\n'
    b'\n'
    b"  await test('registration stores exactly one verification token in the database', async () => {\n"
    b'    const { rows } = await pool.query(\n'
    b'      `SELECT evt.* FROM email_verification_tokens evt\n'
    b'       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,\n'
    b'      [registeredEmail]\n'
    b'    );\n'
    b'    assert(rows.length === 1, `expected 1 token, got ${rows.length}`);\n'
    b"    assert(new Date(rows[0].expires_at) > new Date(), 'token should not already be expired');\n"
    b'  });\n'
    b'\n'
    b"  await test('expired verification token returns 400', async () => {\n"
    b'    const user = await insertTestUser(uniqueEmail());\n'
    b"    const rawToken = crypto.randomBytes(32).toString('hex');\n"
    b"    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');\n"
    b'    await pool.query(\n'
    b'      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)\n'
    b"       VALUES ($1, $2, NOW() - INTERVAL '1 second')`,\n"
    b'      [user.id, hash]\n'
    b'    );\n'
    b'    const res = await request(app).get(`/auth/verify-email?token=${rawToken}`);\n'
    b'    assert(res.status === 400, `expected 400, got ${res.status}`);\n'
    b"    assert(res.body.error, 'should have error message');\n"
    b'  });\n'
    b'\n'
    b'  let consumedToken;\n'
    b"  await test('valid verification token verifies account and is consumed', async () => {\n"
    b'    const user = await insertTestUser(uniqueEmail());\n'
    b"    consumedToken = crypto.randomBytes(32).toString('hex');\n"
    b"    const hash = crypto.createHash('sha256').update(consumedToken).digest('hex');\n"
    b'    await pool.query(\n'
    b'      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)\n'
    b"       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,\n"
    b'      [user.id, hash]\n'
    b'    );\n'
    b'    const res = await request(app).get(`/auth/verify-email?token=${consumedToken}`);\n'
    b'    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);\n'
    b"    assert(res.body.message, 'should have success message');\n"
    b"    const { rows: uRows } = await pool.query('SELECT email_verified FROM users WHERE id = $1', [user.id]);\n"
    b"    assert(uRows[0].email_verified === true, 'email_verified should be true in DB');\n"
    b'    const { rows: tRows } = await pool.query(\n'
    b"      'SELECT * FROM email_verification_tokens WHERE user_id = $1', [user.id]\n"
    b'    );\n'
    b"    assert(tRows.length === 0, 'token should be deleted after successful verification');\n"
    b'  });\n'
    b'\n'
    b"  await test('verification token cannot be reused after successful verification', async () => {\n"
    b"    assert(consumedToken, 'consumedToken must be set from previous test');\n"
    b'    const res = await request(app).get(`/auth/verify-email?token=${consumedToken}`);\n'
    b'    assert(res.status === 400, `expected 400, got ${res.status}`);\n'
    b'  });\n'
    b'\n'
    b"  console.log('\\nPOST /auth/resend-verification');\n"
    b'\n'
    b"  await test('missing email field returns 400', async () => {\n"
    b"    const res = await request(app).post('/auth/resend-verification').send({});\n"
    b'    assert(res.status === 400, `expected 400, got ${res.status}`);\n'
    b'  });\n'
    b'\n'
    b"  await test('unknown email returns generic 200 without leaking existence', async () => {\n"
    b'    const res = await request(app)\n'
    b"      .post('/auth/resend-verification')\n"
    b"      .send({ email: 'nobody-resend@nowhere.invalid' });\n"
    b'    assert(res.status === 200, `expected 200, got ${res.status}`);\n'
    b"    assert(res.body.message, 'should have message');\n"
    b'  });\n'
    b'\n'
    b"  await test('already-verified user returns generic 200 and no token is created', async () => {\n"
    b'    const res = await request(app)\n'
    b"      .post('/auth/resend-verification')\n"
    b"      .send({ email: 'buyer@cricket.test' });\n"
    b'    assert(res.status === 200, `expected 200, got ${res.status}`);\n'
    b"    assert(res.body.message, 'should have message');\n"
    b"    const { rows: uRows } = await pool.query('SELECT id FROM users WHERE email = $1', ['buyer@cricket.test']);\n"
    b'    const { rows: tRows } = await pool.query(\n'
    b"      'SELECT * FROM email_verification_tokens WHERE user_id = $1', [uRows[0].id]\n"
    b'    );\n'
    b"    assert(tRows.length === 0, 'verified user should not receive a new token');\n"
    b'  });\n'
    b'\n'
    b"  await test('unverified user gets a new token; old token is replaced', async () => {\n"
    b'    const { rows: oldRows } = await pool.query(\n'
    b'      `SELECT evt.id FROM email_verification_tokens evt\n'
    b'       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,\n'
    b'      [registeredEmail]\n'
    b'    );\n'
    b'    const oldTokenId = oldRows[0]?.id;\n'
    b'\n'
    b'    const res = await request(app)\n'
    b"      .post('/auth/resend-verification')\n"
    b'      .send({ email: registeredEmail });\n'
    b'    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);\n'
    b"    assert(res.body.message, 'should have message');\n"
    b'\n'
    b'    const { rows: newRows } = await pool.query(\n'
    b'      `SELECT evt.* FROM email_verification_tokens evt\n'
    b'       JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,\n'
    b'      [registeredEmail]\n'
    b'    );\n'
    b'    assert(newRows.length === 1, `expected 1 replacement token, got ${newRows.length}`);\n'
    b'    if (oldTokenId) {\n'
    b"      assert(newRows[0].id !== oldTokenId, 'replacement token should have a new id');\n"
    b'    }\n'
    b"    assert(new Date(newRows[0].expires_at) > new Date(), 'replacement token should not be expired');\n"
    b'  });\n'
    b'\n'
)

if marker_line in content:
    content = content.replace(marker_line, new_tests + marker_line, 1)
    open('auth-service/tests/auth.test.js', 'wb').write(content)
    print('INSERTED OK')
else:
    print('MARKER NOT FOUND')
    sys.exit(1)
