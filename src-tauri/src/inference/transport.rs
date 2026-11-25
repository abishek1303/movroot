use super::Failure;
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, StatusCode, header};
use serde::Serialize;
use serde_json::Value;
use std::{io::Cursor, sync::LazyLock, time::Duration};

const ENDPOINT: &str = "https://api.meta.ai/v1/responses";
const MAX_REQUEST: usize = 128 * 1024;
pub const MAX_RESPONSE: usize = 256 * 1024;
const MAX_IMAGE: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../fixtures/inference-diagnostic.json"))
        .expect("bundled diagnostic fixture JSON")
});

pub fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
}

fn only(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().all(|key| keys.contains(&key.as_str())))
}

fn valid_image(url: &str) -> bool {
    let Some((prefix, encoded)) = url.split_once(',') else {
        return false;
    };
    let format = match prefix {
        "data:image/png;base64" => image::ImageFormat::Png,
        "data:image/jpeg;base64" => image::ImageFormat::Jpeg,
        _ => return false,
    };
    if encoded.len() > 4 * MAX_IMAGE.div_ceil(3) {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    if bytes.len() > MAX_IMAGE || image::guess_format(&bytes).ok() != Some(format) {
        return false;
    }
    image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .is_ok_and(|(width, height)| (1..=512).contains(&width) && (1..=512).contains(&height))
}

pub fn validate(body: &str) -> Result<String, Failure> {
    if body.len() > MAX_REQUEST {
        return Err(Failure::new("requestLimit"));
    }
    let body: Value = serde_json::from_str(body).map_err(|_| Failure::new("invalidRequest"))?;
    let valid = only(
        &body,
        &[
            "model",
            "instructions",
            "input",
            "reasoning",
            "max_output_tokens",
            "text",
            "store",
            "stream",
            "background",
        ],
    ) && body["model"].as_str() == Some("muse-ember-1.0")
        && body["instructions"] == FIXTURES["instructions"]
        && ["store", "stream", "background"]
            .iter()
            .all(|&key| body[key].as_bool() == Some(false))
        && body["max_output_tokens"]
            .as_u64()
            .is_some_and(|count| (16..=512).contains(&count))
        && only(&body["reasoning"], &["effort"])
        && body["reasoning"]["effort"].as_str() == Some("minimal")
        && only(&body["text"], &["format"]);
    let format = &body["text"]["format"];
    if !valid
        || !only(format, &["type", "name", "strict", "schema"])
        || format["type"].as_str() != Some("json_schema")
        || format["strict"].as_bool() != Some(true)
        || format["name"] != FIXTURES["schemaName"]
        || format["schema"] != FIXTURES["schema"]
    {
        return Err(Failure::new("invalidRequest"));
    }
    let Some([message]) = body["input"].as_array().map(Vec::as_slice) else {
        return Err(Failure::new("invalidRequest"));
    };
    if !only(message, &["type", "role", "content"])
        || message["type"].as_str() != Some("message")
        || message["role"].as_str() != Some("user")
    {
        return Err(Failure::new("invalidRequest"));
    }
    let Some([text, rest @ ..]) = message["content"].as_array().map(Vec::as_slice) else {
        return Err(Failure::new("invalidRequest"));
    };
    if !only(text, &["type", "text"])
        || text["type"].as_str() != Some("input_text")
        || !text["text"]
            .as_str()
            .is_some_and(|text| !text.is_empty() && text.len() <= 4096)
    {
        return Err(Failure::new("invalidRequest"));
    }
    match rest {
        [] if text["text"] == FIXTURES["text"] => {}
        [image]
            if text["text"] == FIXTURES["imagePrompt"]
                && only(image, &["type", "image_url"])
                && image["type"].as_str() == Some("input_image")
                && image["image_url"].as_str().is_some_and(|url| {
                    url.strip_prefix("data:image/png;base64,") == FIXTURES["png"].as_str()
                        && valid_image(url)
                }) => {}
        _ => return Err(Failure::new("invalidRequest")),
    }
    // Send the checked object, so duplicate JSON keys cannot be interpreted differently upstream.
    let canonical = body.to_string();
    if canonical.len() > MAX_REQUEST {
        return Err(Failure::new("requestLimit"));
    }
    Ok(canonical)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    http_status: u16,
    body: String,
}

fn network_error(error: reqwest::Error) -> Failure {
    Failure::new(if error.is_timeout() {
        "timeout"
    } else {
        "network"
    })
}

fn retry_after(value: &str, now_seconds: u64) -> Option<u32> {
    let seconds = if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        value.parse::<u32>().ok()?
    } else {
        let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        let now = i64::try_from(now_seconds).ok()?;
        u32::try_from(date.timestamp().saturating_sub(now).max(0)).ok()?
    };
    (seconds <= 3600).then_some(seconds)
}

pub async fn send(client: &Client, key: &str, body: String) -> Result<Reply, Failure> {
    let mut token = header::HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| Failure::new("invalidCredential"))?;
    token.set_sensitive(true);
    let mut response = client
        .post(ENDPOINT)
        .header(header::AUTHORIZATION, token)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    if status != StatusCode::OK {
        let mut fail = Failure::new(match status.as_u16() {
            400 | 413 | 422 => "requestRejected",
            401 => "authentication",
            403 => "accessDenied",
            429 => "rateLimited",
            408 | 504 => "timeout",
            500..=599 => "providerUnavailable",
            _ => "httpFailure",
        });
        fail.http_status = Some(status.as_u16());
        if status == StatusCode::TOO_MANY_REQUESTS {
            fail.retry_after_seconds = response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    let now = std::time::UNIX_EPOCH
                        .elapsed()
                        .unwrap_or_default()
                        .as_secs();
                    retry_after(value, now)
                });
        }
        return Err(fail);
    }
    if response
        .content_length()
        .is_some_and(|count| count > MAX_RESPONSE as u64)
    {
        return Err(Failure::new("responseLimit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_RESPONSE - bytes.len() {
            return Err(Failure::new("responseLimit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| Failure::new("invalidResponse"))?;
    if body.contains(key) {
        return Err(Failure::new("invalidResponse"));
    }
    Ok(Reply {
        http_status: status.as_u16(),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_bounded_retry_after_delays_and_dates() {
        assert_eq!(retry_after("120", 0), Some(120));
        assert_eq!(retry_after("3601", 0), None);
        assert_eq!(retry_after("+10", 0), None);
        assert_eq!(
            retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_767),
            Some(10)
        );
    }

    #[test]
    fn accepts_stateless_text_but_rejects_egress_options() {
        let mut payload = serde_json::json!({
            "model":"muse-ember-1.0", "instructions":FIXTURES["instructions"], "reasoning":{"effort":"minimal"},
            "stream":false,"store":false,"background":false,"max_output_tokens":512,
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":FIXTURES["text"]}]}],
            "text":{"format":{"type":"json_schema","name":FIXTURES["schemaName"],"strict":true,"schema":FIXTURES["schema"]}}
        });
        assert!(validate(&payload.to_string()).is_ok());
        let mut arbitrary = payload.clone();
        arbitrary["input"][0]["content"][0]["text"] = Value::String("arbitrary".to_owned());
        assert!(validate(&arbitrary.to_string()).is_err());

        let mut image = payload.clone();
        image["input"][0]["content"] = serde_json::json!([
            {"type": "input_text", "text": FIXTURES["imagePrompt"]},
            {"type": "input_image", "image_url": format!("data:image/png;base64,{}", FIXTURES["png"].as_str().unwrap())}
        ]);
        assert!(validate(&image.to_string()).is_ok());

        payload["input"][0]["content"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"type":"input_image","image_url":"https://example.invalid"}));
        assert!(validate(&payload.to_string()).is_err());
        assert!(validate(&"a".repeat(MAX_REQUEST + 1)).is_err());
    }
}
