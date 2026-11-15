u = User.find_by_username('root')
u.personal_access_tokens.where(name: 'openchamber-local').each(&:revoke!)
t = u.personal_access_tokens.new(name: 'openchamber-local', scopes: [:api], expires_at: 365.days.from_now)
t.set_token(SecureRandom.hex(20))
t.save!
puts "TOKEN=#{t.token}"
