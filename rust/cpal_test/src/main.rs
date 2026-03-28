use cpal::traits::{DeviceTrait, HostTrait};
fn main() -> anyhow::Result<()> {
    let host = cpal::default_host();
    let in_dev = host.default_input_device().unwrap();
    let out_dev = host.default_output_device().unwrap();
    println!("In: {:?}", in_dev.default_input_config()?);
    println!("Out: {:?}", out_dev.default_output_config()?);
    Ok(())
}
