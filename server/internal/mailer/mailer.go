// Package mailer provides outbound email delivery for authentication flows.
//
// The mailer is intentionally small: the server only ever needs to deliver a
// short magic-link email and a pairing code fallback. Self-hosters usually
// provide SMTP credentials for a transactional account (Gmail, Mailgun,
// SES-SMTP, etc.).  If no SMTP host is configured the server falls back to
// returning the token in the API response (see auth_handlers.go).
package mailer

import (
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"

	"keepsync-server/internal/config"
)

// Mailer sends authentication-related emails via SMTP.
type Mailer struct {
	host     string
	port     int
	username string
	password string
	from     string
	appName  string
}

// New creates a Mailer using the server config. If SMTP is not configured
// the returned mailer is still usable but `SendMagicLink` will return an
// error; callers should branch on `cfg.IsSMTPEnabled()` first.
func New(cfg *config.Config) *Mailer {
	return &Mailer{
		host:     cfg.SMTPHost,
		port:     cfg.SMTPPort,
		username: cfg.SMTPUsername,
		password: cfg.SMTPPassword,
		from:     cfg.SMTPFrom,
		appName:  "KeepSync",
	}
}

// SendMagicLink delivers a magic-link activation email. The `link` argument is
// a fully-formed URL the recipient can open in a browser; `token` is included
// as plain text so users can paste it into the extension options if their
// email client strips HTML links.
func (m *Mailer) SendMagicLink(to, link, token string) error {
	if m.host == "" {
		return fmt.Errorf("smtp not configured")
	}

	subject := m.appName + ": your sign-in link"
	body := strings.Join([]string{
		"Hi there,",
		"",
		"Click the link below to activate your device:",
		link,
		"",
		"Or, if you prefer, paste this code into the extension:",
		token,
		"",
		"This link/code expires in 15 minutes. If you didn't request it, you can ignore this email.",
		"",
		"— " + m.appName,
	}, "\r\n")

	msg := m.buildMessage(to, subject, body)

	addr := net.JoinHostPort(m.host, strconv.Itoa(m.port))
	auth := smtp.PlainAuth("", m.username, m.password, m.host)

	return smtp.SendMail(addr, auth, m.from, []string{to}, msg)
}

func (m *Mailer) buildMessage(to, subject, body string) []byte {
	headers := []string{
		"From: " + m.from,
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
	}
	return []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body)
}
