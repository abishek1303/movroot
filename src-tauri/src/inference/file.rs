use super::Failure;
use crate::device::analysis::{
    AnalysisCoverage, Content, ORIGINAL_IMAGE_LIMIT, PDF_LIMIT, PreparedFile,
};
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
    InputFile { file_data: String },
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

pub fn request(prepared: &PreparedFile) -> Result<String, Failure> {
    let hint = match prepared.coverage {
        AnalysisCoverage::Original { .. } => "Analyze the supplied content.",
        AnalysisCoverage::Text {
            source_bytes,
            covered_bytes,
            ..
        } if source_bytes != covered_bytes => "The following file content is a text excerpt.",
        AnalysisCoverage::Image { resized: true, .. } => {
            "The following file content is a resized image."
        }
        _ => "The following is the prepared file content.",
    };
    let part = match &prepared.content {
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
        Content::Original(bytes)
            if !bytes.is_empty()
                && bytes.len()
                    <= match prepared.format {
                        "pdf" => PDF_LIMIT,
                        "png" | "jpeg" => ORIGINAL_IMAGE_LIMIT,
                        _ => 0,
                    } =>
        {
            Part::InputFile {
                file_data: STANDARD.encode(bytes),
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
