// Standard Library Imports
use std::sync::{Arc, Mutex};

// External Crate Imports
use drift::state::user::User;
use crate::event_emitter::EventEmitter;
use solana_account_decoder::UiAccountEncoding;
use solana_sdk::commitment_config::CommitmentConfig;

// Internal Crate/Module Imports
use crate::{
    memcmp::{get_user_filter, get_user_with_auction_filter},
    types::{DataAndSlot, SdkResult},
    websocket_program_account_subscriber::{
        ProgramAccountUpdate, WebsocketProgramAccountOptions, WebsocketProgramAccountSubscriber
    },
};

pub struct AuctionSubscriberConfig {
    pub commitment: CommitmentConfig,
    pub resub_timeout_ms: Option<u64>,
    pub url: String,
}

/// To subscribe to auction updates, subscribe to the event_emitter's "auction" event type.
pub struct AuctionSubscriber {
    pub subscriber: WebsocketProgramAccountSubscriber,
    pub event_emitter: EventEmitter,
}

impl AuctionSubscriber {
    pub fn new(config: AuctionSubscriberConfig) -> Self {
        let event_emitter = EventEmitter::new();

        let filters = vec![get_user_filter(), get_user_with_auction_filter()];

        let websocket_options = WebsocketProgramAccountOptions {
            filters,
            commitment: config.commitment,
            encoding: UiAccountEncoding::Base64,
        };

        let subscriber = WebsocketProgramAccountSubscriber::new(
            "auction".to_string(),
            config.url.clone(),
            websocket_options,
            event_emitter.clone(),
        );

        AuctionSubscriber {
            subscriber,
            event_emitter: event_emitter.clone(),
        }
    }

    pub async fn subscribe(&mut self) -> SdkResult<()> {
        if self.subscriber.subscribed {
            return Ok(());
        }

        self.subscriber.subscribe::<User>().await?;

        Ok(())
    }

    pub async fn unsubscribe(&mut self) -> SdkResult<()> {
        self.subscriber.unsubscribe().await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use anchor_client::Cluster;

    use super::*;

    // this is my (frank) free helius endpoint
    const MAINNET_ENDPOINT: &str =
        "https://mainnet.helius-rpc.com/?api-key=3a1ca16d-e181-4755-9fe7-eac27579b48c";

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn test_auction_subscriber() {
        let cluster = Cluster::from_str(MAINNET_ENDPOINT).unwrap();
        let url = cluster.ws_url().to_string();

        let config = AuctionSubscriberConfig {
            commitment: CommitmentConfig::confirmed(),
            resub_timeout_ms: None,
            url,
        };

        let mut auction_subscriber = AuctionSubscriber::new(config);

        let emitter = auction_subscriber.event_emitter.clone();

        emitter.subscribe("auction", move |event| {
            if let Some(event) = event.as_any().downcast_ref::<ProgramAccountUpdate<User>>() {
                dbg!(event);
            }
        });

        let _ = auction_subscriber.subscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

        let _ = auction_subscriber.unsubscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}
