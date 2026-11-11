//! Display power, the way Screen Sharing handles it: while someone is watching, the
//! display doesn't idle into sleep, and a viewer connecting or sending input wakes it
//! (and resets the idle timer, so the screensaver gives way to the desktop or the lock
//! screen). The screensaver and the lock still follow the Mac's own settings.
//!
//! It also tells the capture when the screen may be capturable again ([`kick`]), so a
//! capture lost to a sleeping display waits for the display to wake instead of asking
//! ScreenCaptureKit over and over.

#![allow(non_upper_case_globals)]
use crate::hub::Hub;
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSWorkspace,
    NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification,
};
use objc2_core_foundation::CFString;
use objc2_foundation::NSNotification;
use parking_lot::{Condvar, Mutex};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Counts the moments the screen may have become capturable: the display woke, a
/// viewer arrived, or remote input came in.
static KICKS: Mutex<u64> = Mutex::new(0);
static KICKED: Condvar = Condvar::new();

/// Says the screen may be capturable again.
pub fn kick() {
    *KICKS.lock() += 1;
    KICKED.notify_all();
}

/// The current kick count, to pass to [`wait_for_kick`].
pub fn kicks() -> u64 {
    *KICKS.lock()
}

/// Waits up to `timeout` for a kick after the count was `seen`. Returns whether one came.
pub fn wait_for_kick(seen: u64, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut n = KICKS.lock();
    while *n == seen {
        if KICKED.wait_until(&mut n, deadline).timed_out() {
            break;
        }
    }
    *n != seen
}

/// Runs the main thread for good, as a background AppKit app (no Dock icon or menu
/// bar). macOS only says the display slept or woke to a process running AppKit's event
/// loop; the loop also runs the main dispatch queue, which the keyboard layout lookups use.
pub fn run_main_thread() -> ! {
    let mtm = MainThreadMarker::new().expect("run_main_thread must run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let woke = RcBlock::new(|_: NonNull<NSNotification>| {
        log::info!("display woke");
        kick();
    });
    let slept = RcBlock::new(|_: NonNull<NSNotification>| log::info!("display slept"));
    // The observers live as long as the process, so their tokens are never released.
    unsafe {
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceScreensDidWakeNotification),
            None,
            None,
            &woke,
        ));
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceScreensDidSleepNotification),
            None,
            None,
            &slept,
        ));
    }
    app.run();
    unreachable!("NSApplication::run returned");
}

type IOPMAssertionID = u32;
const kIOPMAssertionLevelOn: u32 = 255;
const kIOPMUserActiveLocal: u32 = 0;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(
        ty: *const c_void,
        level: u32,
        name: *const c_void,
        id: *mut IOPMAssertionID,
    ) -> i32;
    fn IOPMAssertionRelease(id: IOPMAssertionID) -> i32;
    fn IOPMAssertionDeclareUserActivity(
        name: *const c_void,
        ty: u32,
        id: *mut IOPMAssertionID,
    ) -> i32;
}

fn cf(s: &CFString) -> *const c_void {
    s as *const CFString as *const c_void
}

struct Activity {
    id: IOPMAssertionID,
    last: Option<Instant>,
}

static ACTIVITY: Mutex<Activity> = Mutex::new(Activity { id: 0, last: None });

/// Tells macOS a user is active: wakes a sleeping display and resets the idle timer.
/// Cheap to call on every input event (throttled to once a second).
pub fn user_activity() {
    let mut a = ACTIVITY.lock();
    if a.last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
        return;
    }
    a.last = Some(Instant::now());
    // Someone is at the controls: a capture waiting on a sleeping or locked screen
    // tries again now rather than at its next scheduled retry.
    kick();
    let name = CFString::from_static_str("voxl remote input");
    // Reusing the ID updates the same assertion instead of piling up new ones.
    let r = unsafe { IOPMAssertionDeclareUserActivity(cf(&name), kIOPMUserActiveLocal, &mut a.id) };
    if r != 0 {
        log::debug!("IOPMAssertionDeclareUserActivity failed: {r:#x}");
    }
}

/// Holds "prevent idle display sleep" while `on`.
struct KeepAwake(Option<IOPMAssertionID>);

impl KeepAwake {
    fn set(&mut self, on: bool) {
        match (on, self.0) {
            (true, None) => {
                let ty = CFString::from_static_str("PreventUserIdleDisplaySleep");
                let name = CFString::from_static_str("voxl: a viewer is connected");
                let mut id = 0;
                let r = unsafe {
                    IOPMAssertionCreateWithName(cf(&ty), kIOPMAssertionLevelOn, cf(&name), &mut id)
                };
                if r == 0 {
                    log::info!("viewer connected: keeping the display awake");
                    self.0 = Some(id);
                } else {
                    log::warn!("could not keep the display awake: IOKit error {r:#x}");
                }
            }
            (false, Some(id)) => {
                unsafe { IOPMAssertionRelease(id) };
                log::info!("no viewers: the display may sleep again");
                self.0 = None;
            }
            _ => {}
        }
    }
}

/// Watches for viewers: wakes the display when the first one arrives and, with
/// --keep-display-awake, keeps it from idling into sleep until the last one leaves.
pub fn spawn(hub: Arc<Hub>) {
    let keep_awake = super::keep_display_awake();
    std::thread::Builder::new()
        .name("power".into())
        .spawn(move || {
            let mut hold = KeepAwake(None);
            let mut viewing = false;
            loop {
                let now = !hub.video_clients().is_empty();
                if now && !viewing {
                    user_activity();
                }
                if keep_awake {
                    hold.set(now);
                }
                viewing = now;
                std::thread::sleep(Duration::from_millis(500));
            }
        })
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kicks_wake_a_waiting_capture() {
        let seen = kicks();
        assert!(!wait_for_kick(seen, Duration::from_millis(20)), "no kick yet");
        let t = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            kick();
        });
        let start = Instant::now();
        assert!(wait_for_kick(seen, Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(1), "woke on the kick, not the timeout");
        t.join().unwrap();
        // A kick that came before the wait still counts.
        assert!(wait_for_kick(seen, Duration::ZERO));
    }
}
