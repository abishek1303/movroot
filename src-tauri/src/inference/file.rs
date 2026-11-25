use super::Failure;
use crate::device::analysis::Content;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

const MAX_REQUEST: usize = 3 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    name: String,
    pub model: String,
    reasoning: String,
    max_output_tokens: u32,
    instructions: String,
    schema: Value,
}

pub static CONFIG: LazyLock<Configuration> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../fixtures/file-semantic-v1.json"))
        .expect("bundled semantic configuration")
});

#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    instructions: &'a str,
    reasoning: Reasoning<'a>,
    max_output_tokens: u32,
    text: TextFormat<'a>,
    store: bool,
    stream: bool,
    background: bool,
    input: [Message<'a>; 1],
}

#[derive(Serialize)]
struct Message<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    role: &'static str,
    content: Vec<Part<'a>>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Part<'a> {
    InputText { text: &'a str },
    InputImage { image_url: String },
}

#[derive(Serialize)]
struct Reasoning<'a> {
    effort: &'a str,
}
#[derive(Serialize)]
struct TextFormat<'a> {
    format: Format<'a>,
}
#[derive(Serialize)]
struct Format<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    name: &'a str,
    strict: bool,
    schema: &'a Value,
}

pub fn request(content: &Content, hint: &str) -> Result<String, Failure> {
    let part = match content {
        Content::Text(text) if !text.is_empty() && text.len() <= 16 * 1024 => {
            Part::InputText { text }
        }
        Content::Image { mime, bytes }
            if matches!(*mime, "image/png" | "image/jpeg")
                && !bytes.is_empty()
                && bytes.len() <= 2 * 1024 * 1024 =>
        {
            Part::InputImage {
                image_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
            }
        }
        _ => return Err(Failure::new("requestLimit")),
    };
    let config = &*CONFIG;
    let request = Request {
        model: &config.model,
        instructions: &config.instructions,
        input: [Message {
            kind: "message",
            role: "user",
            content: vec![Part::InputText { text: hint }, part],
        }],
        reasoning: Reasoning {
            effort: &config.reasoning,
        },
        max_output_tokens: config.max_output_tokens,
        text: TextFormat {
            format: Format {
                kind: "json_schema",
                name: &config.name,
                strict: true,
                schema: &config.schema,
            },
        },
        store: false,
        stream: false,
        background: false,
    };
    let body = serde_json::to_string(&request).map_err(|_| Failure::new("invalidRequest"))?;
    if body.len() > MAX_REQUEST {
        return Err(Failure::new("requestLimit"));
    }
    Ok(body)
}
