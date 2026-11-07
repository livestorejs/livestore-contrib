{
  config,
  lib,
  ...
}:
let
  cfg = config.services.livestoreDiscordGatewayRelay;
  stateDirectory = "livestore-discord-relay-${cfg.stage}";
in
{
  options.services.livestoreDiscordGatewayRelay = {
    enable = lib.mkEnableOption "the LiveStore Discord Gateway relay";
    stage = lib.mkOption {
      type = lib.types.enum [
        "staging"
        "production"
      ];
      description = "Discord bot stage served by this relay.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      description = "Immutable LiveStore Discord package containing the relay command.";
    };
    origin = lib.mkOption { type = lib.types.str; };
    guildId = lib.mkOption { type = lib.types.strMatching "[0-9]{17,20}"; };
    applicationId = lib.mkOption { type = lib.types.strMatching "[0-9]{17,20}"; };
    channelIds = lib.mkOption {
      type = lib.types.nonEmptyListOf (lib.types.strMatching "[0-9]{17,20}");
    };
    discordTokenFile = lib.mkOption { type = lib.types.str; };
    relayTokenFile = lib.mkOption { type = lib.types.str; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          lib.hasPrefix "/" cfg.discordTokenFile
          && lib.hasPrefix "/" cfg.relayTokenFile
          && !(lib.hasPrefix builtins.storeDir cfg.discordTokenFile)
          && !(lib.hasPrefix builtins.storeDir cfg.relayTokenFile)
          && cfg.discordTokenFile != cfg.relayTokenFile;
        message = "The Discord relay requires distinct absolute runtime credential files outside the Nix store.";
      }
    ];

    systemd.services.${stateDirectory} = {
      description = "LiveStore Discord Gateway relay (${cfg.stage})";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      startLimitIntervalSec = 0;

      environment = {
        LIVESTORE_DISCORD_RELAY_ORIGIN = cfg.origin;
        LIVESTORE_DISCORD_RELAY_GUILD = cfg.guildId;
        LIVESTORE_DISCORD_RELAY_APPLICATION = cfg.applicationId;
        LIVESTORE_DISCORD_RELAY_CHANNELS = lib.concatStringsSep "," cfg.channelIds;
        LIVESTORE_DISCORD_RELAY_STATE = "/var/lib/${stateDirectory}";
      };

      serviceConfig = {
        ExecStart = "${lib.getExe' cfg.package "livestore-discord"} relay";
        DynamicUser = true;
        StateDirectory = stateDirectory;
        StateDirectoryMode = "0700";
        UMask = "0077";
        LoadCredential = [
          "discord-bot-token:${cfg.discordTokenFile}"
          "gateway-relay-token:${cfg.relayTokenFile}"
        ];
        Restart = "on-failure";
        RestartSec = "15s";
        TimeoutStopSec = "15s";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
      };
    };
  };
}
