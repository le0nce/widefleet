use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json as value};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List the schedules of the active deployment with their latest run.
    List,
    /// Show recent runs, newest first. Widefleet keeps the latest 100 runs per app.
    Runs {
        /// Only show runs of this schedule expression.
        #[arg(long)]
        cron: Option<String>,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u8).range(1..=100))]
        limit: u8,
    },
    /// Start a declared schedule now through the app's scheduled handler.
    Run {
        cron: String,
        /// Print the queued operation and return without waiting for the agent.
        #[arg(long)]
        no_wait: bool,
    },
    /// Read a previously queued manual run.
    Operation { id: Uuid },
}

#[derive(Deserialize, Serialize)]
struct Operation {
    id: Uuid,
    state: String,
    message: Option<String>,
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let (cron, no_wait) = match options.command {
        Command::List => {
            let response: Value = json(
                api.authenticated(Method::GET, &format!("/apps/{app}/crons"), &token)
                    .send()
                    .await?,
            )
            .await?;
            return super::print_json(&response);
        }
        Command::Runs { cron, limit } => {
            let mut query = vec![("limit", limit.to_string())];
            if let Some(cron) = cron {
                query.push(("cron", cron));
            }
            let response: Value = json(
                api.authenticated(Method::GET, &format!("/apps/{app}/crons/runs"), &token)
                    .query(&query)
                    .send()
                    .await?,
            )
            .await?;
            return super::print_json(&response);
        }
        Command::Operation { id } => {
            let response: Operation = json(
                api.authenticated(
                    Method::GET,
                    &format!("/apps/{app}/crons/operations/{id}"),
                    &token,
                )
                .send()
                .await?,
            )
            .await?;
            return super::print_json(&response);
        }
        Command::Run { cron, no_wait } => (cron, no_wait),
    };
    let request_id = Uuid::new_v4();
    eprintln!("Cron run: {request_id}");
    let mut operation: Operation = json(
        api.authenticated(Method::POST, &format!("/apps/{app}/crons/runs"), &token)
            .header("idempotency-key", request_id.to_string())
            .json(&value!({ "cron": cron }))
            .send()
            .await?,
    )
    .await?;
    while !no_wait && matches!(operation.state.as_str(), "queued" | "running") {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let token = auth::access_token(api, credentials).await?;
        operation = json(
            api.authenticated(
                Method::GET,
                &format!("/apps/{app}/crons/operations/{}", operation.id),
                &token,
            )
            .send()
            .await?,
        )
        .await?;
    }
    super::print_json(&operation)?;
    if operation.state == "failed" {
        return Err(Error::invalid(
            operation
                .message
                .unwrap_or_else(|| "The Cron run could not be started".into()),
        ));
    }
    if operation.state == "succeeded" {
        eprintln!("The run has started; follow its result with `widefleet crons runs`.");
    }
    Ok(())
}
