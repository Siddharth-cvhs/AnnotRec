// Dev tool: record a physical-pixel region of the primary monitor with the
// default mic, optionally pausing in the middle, and print what happened.
// Usage: record_test <seconds> <x> <y> <w> <h> <out.mp4> [pause_at_s pause_for_s]
use std::{path::Path, time::Duration};

use annotrec_lib::{
    area::{self, Rect},
    audio,
    wgc::Recorder,
};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let secs: f64 = a[1].parse().unwrap();
    let n = |i: usize| a[i].parse::<i32>().unwrap();
    let out = Path::new(&a[6]);
    let pause: Option<(f64, f64)> = a.get(7).zip(a.get(8)).map(|(p, d)| (p.parse().unwrap(), d.parse().unwrap()));

    let area = area::area_of(Rect { x: n(2), y: n(3), width: n(4) as u32, height: n(5) as u32 }).expect("area");
    let inputs = audio::inputs();
    let mut choice = match inputs.iter().find(|i| i.default).or(inputs.first()) {
        Some(i) => audio::Choice { input: Some(i.clone()), default: true, issue: None },
        None => audio::Choice::default(),
    };
    let rec = Recorder::start(&area, out, &mut choice).expect("start");
    println!("RECORDING area={area:?} mic_issue={:?}", choice.issue);
    let step = |s: f64| std::thread::sleep(Duration::from_secs_f64(s));
    match pause {
        Some((at, dur)) => {
            step(at);
            rec.controls.paused.store(true, std::sync::atomic::Ordering::SeqCst);
            println!("PAUSED");
            step(dur);
            rec.controls.paused.store(false, std::sync::atomic::Ordering::SeqCst);
            println!("RESUMED");
            step((secs - at).max(0.0));
        }
        None => step(secs),
    }
    rec.stop(Duration::from_secs(15)).expect("stop");
    println!("DONE {}", out.display());
}
