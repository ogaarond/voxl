//! Display power, the way Screen Sharing handles it: while someone is watching, the
//! display doesn't idle into sleep, and a viewer connecting or sending input wakes it
//! (and resets the idle timer, so the screensaver gives way to the desktop or the lock
//! screen). The screensaver and the lock still follow the Mac's own settings.

#![allow(non_upper_case_globals)]
use crate::hub::Hub;
use objc2_core_foundation::CFString;
use parking_lot::Mutex;
use std::ffi::c_void;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
