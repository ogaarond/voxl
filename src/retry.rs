//! Logging for retry loops that can run for hours, such as a Mac's capture waiting for
//! its display to wake: the first failure is a warning, the same failure repeats at
//! doubling intervals (30 s up to an hour), a different failure is logged straight
//! away, and recovery says how long it took.

use std::time::{Duration, Instant};

const FIRST_REPEAT: Duration = Duration::from_secs(30);
const MAX_REPEAT: Duration = Duration::from_secs(3600);

pub struct RetryLog {
    what: &'static str,
    /// When the current run of failures began.
    since: Option<Instant>,
    last_err: String,
    next_log: Instant,
    gap: Duration,
}

impl RetryLog {
    pub fn new(what: &'static str) -> Self {
        RetryLog {
            what,
            since: None,
            last_err: String::new(),
            next_log: Instant::now(),
            gap: FIRST_REPEAT,
        }
    }

    pub fn failed(&mut self, err: &str) {
        self.failed_at(Instant::now(), err);
    }

    pub fn recovered(&mut self) {
        self.recovered_at(Instant::now());
    }

    /// Returns whether the failure was logged.
    fn failed_at(&mut self, now: Instant, err: &str) -> bool {
        let Some(since) = self.since else {
            log::warn!("{} unavailable ({err}); retrying", self.what);
            self.since = Some(now);
            self.last_err = err.to_owned();
            self.gap = FIRST_REPEAT;
            self.next_log = now + self.gap;
            return true;
        };
        if err != self.last_err {
            log::warn!("{} unavailable ({err}); retrying", self.what);
        } else if now >= self.next_log {
            log::warn!(
                "{} still unavailable after {} ({err}); retrying",
                self.what,
                human(now - since)
            );
            self.gap = (self.gap * 2).min(MAX_REPEAT);
        } else {
            return false;
        }
        self.last_err = err.to_owned();
        self.next_log = now + self.gap;
        true
    }

    /// Returns whether there had been failures to recover from.
    fn recovered_at(&mut self, now: Instant) -> bool {
        let Some(since) = self.since.take() else {
            return false;
        };
        log::info!(
            "{} resumed after {:.1} s",
            self.what,
            (now - since).as_secs_f64()
        );
        self.last_err.clear();
        true
    }
}

fn human(d: Duration) -> String {
    let s = d.as_secs();
    match s {
        0..120 => format!("{s} s"),
        120..7200 => format!("{} min", s / 60),
        _ => format!("{:.1} h", s as f64 / 3600.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_back_off_and_new_errors_log_at_once() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut r = RetryLog::new("capture");
        assert!(!r.recovered_at(t0), "nothing to recover from yet");

        // Retrying every 2 s for a day logs a handful of lines, not thousands.
        let logged = (0..43_200)
            .filter(|i| r.failed_at(at(i * 2), "asleep"))
            .count();
        assert!(logged < 40, "{logged} lines in a day");
        // 0, 30, 90, 210, 450, 930, 1890, 3810, 7650 s, then hourly.
        assert!(r.failed_at(at(86_400 + 3600), "asleep"));

        assert!(r.failed_at(at(86_400 + 3602), "permission denied"));
        assert!(!r.failed_at(at(86_400 + 3604), "permission denied"));
        assert!(r.recovered_at(at(86_400 + 3606)));
        assert!(!r.recovered_at(at(86_400 + 3608)));

        // A new outage starts over with a warning and the short interval.
        assert!(r.failed_at(at(100_000), "asleep"));
        assert!(!r.failed_at(at(100_020), "asleep"));
        assert!(r.failed_at(at(100_030), "asleep"));
    }

    #[test]
    fn human_durations() {
        assert_eq!(human(Duration::from_secs(45)), "45 s");
        assert_eq!(human(Duration::from_secs(600)), "10 min");
        assert_eq!(human(Duration::from_secs(5 * 3600)), "5.0 h");
    }
}
