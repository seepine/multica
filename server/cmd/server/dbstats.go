package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// dbStatsInterval is how often the pool stats are sampled and logged.
	// 15s lines up with the daemon heartbeat cadence so it's easy to
	// correlate with traffic patterns in the prod logs.
	dbStatsInterval = 15 * time.Second
)

// logPoolConfig prints the effective pgxpool configuration once at startup.
// Surfacing this is critical because pgxpool defaults are surprisingly small
// (MaxConns = max(4, NumCPU)) — without seeing the value in the log it's
// easy to mistake pool exhaustion for "the database is slow".
func logPoolConfig(pool *pgxpool.Pool) {
	cfg := pool.Config()
	slog.Info("db pool config",
		"max_conns", cfg.MaxConns,
		"min_conns", cfg.MinConns,
		"max_conn_lifetime", cfg.MaxConnLifetime.String(),
		"max_conn_idle_time", cfg.MaxConnIdleTime.String(),
		"health_check_period", cfg.HealthCheckPeriod.String(),
	)
}

// runDBStatsLogger samples pool.Stat() periodically. It always emits an INFO
// line so operators can see baseline pressure, and emits a WARN whenever the
// EmptyAcquireCount delta is positive — that's the direct symptom of pool
// exhaustion (a request had to wait because no idle conn was available) and
// the smoking gun we're looking for to confirm the slow /tasks/claim
// hypothesis.
func runDBStatsLogger(ctx context.Context, pool *pgxpool.Pool) {
	ticker := time.NewTicker(dbStatsInterval)
	defer ticker.Stop()

	var (
		lastEmpty       int64
		lastAcquire     int64
		lastAcquireDur  time.Duration
		lastCanceled    int64
	)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		s := pool.Stat()
		emptyDelta := s.EmptyAcquireCount() - lastEmpty
		acquireDelta := s.AcquireCount() - lastAcquire
		acquireDurDelta := s.AcquireDuration() - lastAcquireDur
		canceledDelta := s.CanceledAcquireCount() - lastCanceled

		// Average wait per acquire over the last sampling window. Useful
		// because cumulative AcquireDuration alone hides whether the
		// situation is improving or worsening.
		var avgAcquireMs int64
		if acquireDelta > 0 {
			avgAcquireMs = (acquireDurDelta).Milliseconds() / acquireDelta
		}

		fields := []any{
			"max_conns", s.MaxConns(),
			"total_conns", s.TotalConns(),
			"acquired_conns", s.AcquiredConns(),
			"idle_conns", s.IdleConns(),
			"constructing_conns", s.ConstructingConns(),
			"acquire_count_delta", acquireDelta,
			"empty_acquire_delta", emptyDelta,
			"canceled_acquire_delta", canceledDelta,
			"avg_acquire_ms", avgAcquireMs,
		}

		if emptyDelta > 0 || canceledDelta > 0 {
			slog.Warn("db pool pressure", fields...)
		} else {
			slog.Info("db pool stats", fields...)
		}

		lastEmpty = s.EmptyAcquireCount()
		lastAcquire = s.AcquireCount()
		lastAcquireDur = s.AcquireDuration()
		lastCanceled = s.CanceledAcquireCount()
	}
}
