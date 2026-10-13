use crate::{config::Configuration, telemetry::platform_endpoint};
use platform_core::{
    Result,
    http::{Api, json},
    model::{Job, TelemetryDestination},
};
use reqwest::Method;
use serde::Deserialize;

#[derive(Deserialize)]
struct Credentials {
    token: String,
}

/// Where the runtime loader reports this app's Cron runs.
pub async fn destination(
    api: &Api,
    configuration: &Configuration,
    job: &Job,
) -> Result<TelemetryDestination> {
    let credentials: Credentials = json(
        api.authenticated(
            Method::GET,
            &format!("/agent/jobs/{}/crons", job.id),
            &configuration.token,
        )
        .query(&[("leaseToken", job.lease_token)])
        .send()
        .await?,
    )
    .await?;
    Ok(TelemetryDestination {
        url: platform_endpoint(
            api,
            configuration,
            &format!("/api/v1/crons/{}/runs", job.app_id()?),
        )?,
        token: credentials.token,
    })
}
