use rand::Rng;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

/// Game draws are separate from the independent synthesis price lottery.
/// Scripted draws support deterministic simulation without production flags.
#[derive(Clone, Debug, Default)]
pub struct RandomSource {
    script: Option<Arc<Mutex<VecDeque<f64>>>>,
}
impl RandomSource {
    pub fn scripted(values: Vec<f64>) -> Self {
        Self {
            script: Some(Arc::new(Mutex::new(values.into()))),
        }
    }
    pub fn draw(&self) -> f64 {
        self.script.as_ref().map_or_else(
            || rand::thread_rng().r#gen(),
            |values| {
                values
                    .lock()
                    .expect("random script mutex poisoned")
                    .pop_front()
                    .unwrap_or(0.0)
            },
        )
    }
    pub(crate) fn index(&self, length: usize) -> usize {
        assert!(length > 0);
        let draw = self.draw();
        let draw = if draw.is_nan() { 0.0 } else { draw };
        ((draw * length as f64).floor() as usize).min(length - 1)
    }
}
