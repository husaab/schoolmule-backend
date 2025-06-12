const passwordQueries = {

    createPasswordResetToken: `
        INSERT INTO password_reset_tokens (user_id, expires_at)
        VALUES ($1, NOW() + interval '15 minutes')
        RETURNING token;
    `,

    validatePasswordResetToken: `
        SELECT * FROM password_reset_tokens
        WHERE token = $1 AND expires_at > NOW();
    `,

    deletePasswordResetToken: `
        DELETE FROM password_reset_tokens WHERE token = $1;
    `


}

module.exports = passwordQueries;