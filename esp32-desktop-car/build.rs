fn main() {
    embuild::espidf::sysenv::output();

    // Always tell cargo to rerun if `.env` appears or changes — even on
    // builds where the file doesn't exist yet. Otherwise the first build
    // (no .env) gets cached and later edits never trigger a rebuild.
    println!("cargo:rerun-if-changed=.env");

    // And rerun if any of the relevant shell env vars change, so callers
    // can override .env values without `cargo clean`.
    for k in [
        "WIFI_SSID",
        "WIFI_PASSWORD",
        "WHIP_ENDPOINT",
        "TOKEN_URL",
        "API_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={k}");
    }

    if !std::path::Path::new(".env").exists() {
        println!("cargo:warning=no .env in project root — firmware will use the placeholder defaults");
        return;
    }

    let body = match std::fs::read_to_string(".env") {
        Ok(b) => b,
        Err(e) => {
            println!("cargo:warning=could not read .env: {e}");
            return;
        }
    };

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        // Shell env wins if the caller exported it deliberately.
        if std::env::var_os(key).is_some() {
            println!("cargo:warning=env: {key} (from shell, not .env)");
            continue;
        }
        println!("cargo:rustc-env={key}={value}");

        // Visible during build so it's obvious whether the value got baked.
        // Mask anything that looks secret.
        let display = if key.contains("PASSWORD") || key.contains("KEY") || key.contains("SECRET") {
            format!("<{} chars>", value.len())
        } else {
            value.to_string()
        };
        println!("cargo:warning=env: {key}={display}");
    }
}
