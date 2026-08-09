fn main() {
    embuild::espidf::sysenv::output();

    // Bake `.env` values into the firmware via cargo:rustc-env.
    // Shell environment variables take precedence (set them before the build
    // and they will override anything in `.env`).
    if std::path::Path::new(".env").exists() {
        println!("cargo:rerun-if-changed=.env");
        for line in std::fs::read_to_string(".env").unwrap().lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                if !value.is_empty() && std::env::var_os(key).is_none() {
                    println!("cargo:rustc-env={key}={value}");
                }
            }
        }
    }
}
