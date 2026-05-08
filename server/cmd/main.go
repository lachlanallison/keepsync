package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"keepsync-server/internal/api"
	"keepsync-server/internal/auth"
	"keepsync-server/internal/config"
	"keepsync-server/internal/storage"
)

func main() {
	loadEnvFiles(".env", "../.env")

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Dev-mode guardrail: auto-generate a random JWT secret so developers
	// don't have to set one, but still refuse to start in production without
	// an explicit secret.
	if cfg.JWTSecret == "" && cfg.DevMode {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			log.Fatalf("Dev mode: failed to generate temporary JWT secret: %v", err)
		}
		cfg.JWTSecret = hex.EncodeToString(b)
		log.Println("Dev mode: generated a temporary JWT_SECRET. Do not use this in production.")
	}

	if cfg.DevMode {
		fmt.Fprintln(os.Stderr, "══════════════════════════════════════════════════════════")
		fmt.Fprintln(os.Stderr, "  WARNING: DEV_MODE IS ENABLED")
		fmt.Fprintln(os.Stderr, "  Magic links will return tokens directly. NEVER use")
		fmt.Fprintln(os.Stderr, "  this in production.")
		fmt.Fprintln(os.Stderr, "══════════════════════════════════════════════════════════")
	}

	if err := cfg.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	// Dispatch subcommands. Anything other than `serve` (default) is a
	// one-shot operation that exits when complete.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "migrate":
			runMigrate(cfg, os.Args[2:])
			return
		case "invite":
			runInvite(cfg, os.Args[2:])
			return
		case "unpair-all":
			runUnpairAll(cfg)
			return
		case "serve", "run":
			// Fall through to normal server startup below.
		case "-h", "--help", "help":
			printUsage()
			return
		default:
			fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", os.Args[1])
			printUsage()
			os.Exit(2)
		}
	}

	db, err := storage.NewDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	if err := storage.Migrate(db); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	authSvc := auth.NewService(db, cfg)

	// First-boot bootstrap: if the devices table is empty, mint a one-shot
	// invite token for the admin identity so the very first extension can
	// pair without needing SMTP or an already-running CLI session. After the
	// first device is registered, subsequent devices use in-app pairing codes
	// from the "Devices" tab, so this path never runs again unless the DB is
	// wiped.
	bootstrapToken := ""
	bootstrapTTL := 24 * time.Hour
	pairedDeviceCount := 0
	if cnt, err := authSvc.CountDevices(); err != nil {
		log.Printf("warning: could not count devices for bootstrap check: %v", err)
	} else {
		pairedDeviceCount = cnt
		if cnt == 0 {
			tok, err := authSvc.GenerateInviteToken(cfg.BootstrapEmail, bootstrapTTL)
			if err != nil {
				log.Printf("warning: failed to mint bootstrap invite token: %v", err)
			} else {
				bootstrapToken = tok
			}
		}
	}

	router := api.NewRouter(db, cfg)

	// SSE/WebSocket: avoid a positive ReadTimeout — it can still bite long-lived
	// GET /realtime/sse streams (~2min drops were seen with ReadTimeout=15s when
	// ResponseWriter doesn’t support ResponseController). Use ReadHeaderTimeout
	// only to cap slow-client header attacks.
	server := &http.Server{
		Addr:              cfg.ServerAddress,
		Handler:           router,
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       0,
		WriteTimeout:      0,
		IdleTimeout:       10 * time.Minute,
	}

	printStartupBanner(cfg, bootstrapToken, bootstrapTTL, pairedDeviceCount)

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed to start: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Graceful shutdown waits for HTTP handlers to finish. Open SSE/WebSocket
	// streams count as active requests, so exit can take until this timeout if
	// clients stay connected (IdleTimeout is 10m for long streams).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Shutdown server
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited")
}

// runMigrate applies pending migrations. Accepts optional `up` or `status`
// subarg so the README documentation works. `down` is intentionally not
// supported yet — migrations are additive and destructive rollbacks risk data
// loss on self-hosted deployments.
func runMigrate(cfg *config.Config, args []string) {
	direction := "up"
	if len(args) > 0 {
		direction = args[0]
	}

	switch direction {
	case "up":
		db, err := storage.NewDB(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("Failed to open database: %v", err)
		}
		defer db.Close()

		if err := storage.Migrate(db); err != nil {
			log.Fatalf("Migration failed: %v", err)
		}
		log.Println("Migrations applied successfully")
	case "status":
		db, err := storage.NewDB(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("Failed to open database: %v", err)
		}
		defer db.Close()
		log.Printf("Database: %s", cfg.DatabaseURL)
		log.Println("Schema is idempotent; re-run `migrate up` to ensure it is current.")
	default:
		fmt.Fprintf(os.Stderr, "Unknown migrate direction: %s (supported: up, status)\n", direction)
		os.Exit(2)
	}
}

// runInvite generates a one-time invite token for bootstrapping a new
// device without needing SMTP. The token is printed to stdout so the admin
// can hand it off out-of-band (password manager, Signal, SSH copy, etc.).
// Use this path instead of magic-link when you do not want to run a mail
// server.
func runInvite(cfg *config.Config, args []string) {
	fs := flag.NewFlagSet("invite", flag.ExitOnError)
	email := fs.String("email", "", "Email (identity) to attach the invite to")
	ttl := fs.Duration("ttl", 24*time.Hour, "How long the invite token is valid for")
	if err := fs.Parse(args); err != nil {
		log.Fatalf("invite: %v", err)
	}
	if *email == "" {
		fmt.Fprintln(os.Stderr, "invite requires --email <address>")
		fs.Usage()
		os.Exit(2)
	}

	db, err := storage.NewDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()
	if err := storage.Migrate(db); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	authSvc := auth.NewService(db, cfg)
	token, err := authSvc.GenerateInviteToken(*email, *ttl)
	if err != nil {
		log.Fatalf("Failed to create invite: %v", err)
	}

	fmt.Println("Invite token created.")
	fmt.Printf("  email:    %s\n", *email)
	fmt.Printf("  expires:  %s\n", time.Now().Add(*ttl).UTC().Format(time.RFC3339))
	fmt.Printf("  token:    %s\n", token)
	fmt.Println()
	fmt.Println("Deliver the token over a secure channel (password manager, SSH, signal, etc.).")
	fmt.Println("The recipient pastes it into the extension's \"Invite token\" field to activate.")
}

// printStartupBanner writes a friendly, scannable banner to stderr so the
// operator immediately sees the listen URL, database path, and (on first
// boot) the invite token needed to pair the very first device.
//
// Deliberately uses fmt.Fprintln on os.Stderr rather than log.Printf so the
// box characters aren't polluted with timestamps.
// runUnpairAll revokes every paired device so the next server start can print
// a fresh bootstrap invite (same as an empty devices table). Use after
// "deleting" data in extensions only cleared local state — server rows stay.
func runUnpairAll(cfg *config.Config) {
	db, err := storage.NewDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("unpair-all: open db: %v", err)
	}
	defer db.Close()

	tx, err := db.Begin()
	if err != nil {
		log.Fatalf("unpair-all: begin: %v", err)
	}
	defer tx.Rollback()

	res, err := tx.Exec(`UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL`)
	if err != nil {
		log.Fatalf("unpair-all: revoke devices: %v", err)
	}
	devN, _ := res.RowsAffected()
	if _, err := tx.Exec(`UPDATE auth_tokens SET revoked = TRUE WHERE type = 'device' AND revoked = FALSE`); err != nil {
		log.Fatalf("unpair-all: revoke device tokens: %v", err)
	}
	if err := tx.Commit(); err != nil {
		log.Fatalf("unpair-all: commit: %v", err)
	}
	fmt.Fprintf(os.Stderr, "unpair-all: revoked %d device(s) and invalidated device tokens. Restart the server to print a new invite token.\n", devN)
}

func printStartupBanner(cfg *config.Config, bootstrapToken string, bootstrapTTL time.Duration, pairedDeviceCount int) {
	addr := cfg.ServerAddress
	displayHost := "localhost"
	if addr != "" && addr[0] != ':' {
		// SERVER_ADDRESS includes a host part (e.g. 0.0.0.0:8787).
		displayHost = addr[:len(addr)-len(portOnly(addr))-1]
		if displayHost == "" || displayHost == "0.0.0.0" {
			displayHost = "localhost"
		}
	}
	port := portOnly(addr)
	url := fmt.Sprintf("http://%s:%s", displayHost, port)

	const bar = "=============================================================="
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, bar)
	fmt.Fprintln(os.Stderr, "  KeepSync Server")
	fmt.Fprintln(os.Stderr, bar)
	fmt.Fprintf(os.Stderr, "  Listening on:  %s  (bind %s)\n", url, addr)
	fmt.Fprintf(os.Stderr, "  Health check:  %s/healthz\n", url)
	fmt.Fprintf(os.Stderr, "  Database:      %s\n", cfg.DatabaseURL)
	if cfg.DevMode {
		fmt.Fprintln(os.Stderr, "  Mode:          DEV (magic-link returns token inline)")
	} else {
		fmt.Fprintln(os.Stderr, "  Mode:          production")
	}

	if bootstrapToken != "" {
		fmt.Fprintln(os.Stderr, bar)
		fmt.Fprintln(os.Stderr, "  FIRST-DEVICE BOOTSTRAP")
		fmt.Fprintln(os.Stderr, bar)
		fmt.Fprintln(os.Stderr, "  No devices found in the database. Paste this invite token")
		fmt.Fprintln(os.Stderr, "  into the extension's \"Invite token\" field to pair your")
		fmt.Fprintln(os.Stderr, "  first browser:")
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "      %s\n", bootstrapToken)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "  Identity:  %s\n", cfg.BootstrapEmail)
		fmt.Fprintf(os.Stderr, "  Expires:   %s  (in %s)\n",
			time.Now().Add(bootstrapTTL).Format(time.RFC1123), bootstrapTTL)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  After this device pairs, add other browsers from its")
		fmt.Fprintln(os.Stderr, "  Settings -> Devices tab via \"Generate Pairing Code\".")
	} else if pairedDeviceCount > 0 {
		fmt.Fprintln(os.Stderr, bar)
		fmt.Fprintf(os.Stderr, "  Bootstrap invite not shown: %d paired device(s) remain in the database.\n", pairedDeviceCount)
		fmt.Fprintln(os.Stderr, "  Clearing extension data does not remove server device rows.")
		fmt.Fprintln(os.Stderr, "  To show a new first-device invite: delete the DB file, or run")
		fmt.Fprintln(os.Stderr, "    keepsync-server unpair-all")
		fmt.Fprintln(os.Stderr, "  then restart the server.")
		fmt.Fprintln(os.Stderr, bar)
	}

	fmt.Fprintln(os.Stderr, bar)
	fmt.Fprintln(os.Stderr)
}

// portOnly extracts the port portion of a Go "host:port" bind string. For
// a bare port like ":8787" it returns "8787".
func portOnly(addr string) string {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[i+1:]
		}
	}
	return addr
}

func printUsage() {
	fmt.Println("keepsync-server — Cross-Browser Tab Sync API server")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  keepsync-server [serve]        Start the HTTP API server (default)")
	fmt.Println("  keepsync-server migrate [up]   Apply database migrations")
	fmt.Println("  keepsync-server migrate status Print schema/database status")
	fmt.Println("  keepsync-server invite --email <addr> [--ttl 24h]")
	fmt.Println("                                    Mint a one-time invite token (no SMTP needed)")
	fmt.Println("  keepsync-server unpair-all     Revoke all devices (then restart → bootstrap invite)")
	fmt.Println("  keepsync-server help           Show this message")
	fmt.Println()
	fmt.Println("Configuration is read from environment variables; see .env.example.")
}

func loadEnvFiles(paths ...string) {
	loaded := make([]string, 0, len(paths))
	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			if err := godotenv.Load(path); err != nil {
				log.Printf("Failed to load %s: %v", path, err)
				continue
			}
			loaded = append(loaded, path)
		}
	}

	if len(loaded) == 0 {
		log.Printf("No .env file found (checked: %s)", strings.Join(paths, ", "))
		return
	}

	log.Printf("Loaded env file(s): %s", strings.Join(loaded, ", "))
}
