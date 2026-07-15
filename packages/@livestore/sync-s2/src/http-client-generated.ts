// Generated via forked version of https://github.com/tim-smart/openapi-gen
// in order to workaround https://github.com/tim-smart/openapi-gen/issues/75
// Further adjustments:
// 1) Use Effect imports from @livestore/utils/effect
// 2) Fixed CreateOrReconfigureBasinRequest to not be self-referencing
import {
  Data,
  Effect,
  type HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  Schema as S,
} from '@livestore/utils/effect'

export class ListAccessTokensParams extends S.Class<ListAccessTokensParams>('ListAccessTokensParams')({
  prefix: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  start_after: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  limit: S.Int.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(1000)).pipe(S.optional, S.withDecodingDefault(Effect.succeed(1000))),
}) {}

export const ResourceSet = S.Union([
  /**
   * Match only the resource with this exact name.
   * Use an empty string to match no resources.
   */
  S.Struct({
    /**
     * Match only the resource with this exact name.
     * Use an empty string to match no resources.
     */
    exact: S.String,
  }),
  /**
   * Match all resources that start with this prefix.
   * Use an empty string to match all resource.
   */
  S.Struct({
    /**
     * Match all resources that start with this prefix.
     * Use an empty string to match all resource.
     */
    prefix: S.String,
  }),
])

export class ReadWritePermissions extends S.Class<ReadWritePermissions>('ReadWritePermissions')({
  /**
   * Read permission.
   */
  read: S.Boolean.pipe(S.optional, S.withDecodingDefault(Effect.succeed(false))),
  /**
   * Write permission.
   */
  write: S.Boolean.pipe(S.optional, S.withDecodingDefault(Effect.succeed(false))),
}) {}

export class PermittedOperationGroups extends S.Class<PermittedOperationGroups>('PermittedOperationGroups')({
  account: S.optional(S.NullOr(ReadWritePermissions)),
  basin: S.optional(S.NullOr(ReadWritePermissions)),
  stream: S.optional(S.NullOr(ReadWritePermissions)),
}) {}

export const Operation = S.Literals([
  'list-basins',
  'create-basin',
  'delete-basin',
  'reconfigure-basin',
  'get-basin-config',
  'issue-access-token',
  'revoke-access-token',
  'list-access-tokens',
  'list-streams',
  'create-stream',
  'delete-stream',
  'get-stream-config',
  'reconfigure-stream',
  'check-tail',
  'append',
  'read',
  'trim',
  'fence',
  'account-metrics',
  'basin-metrics',
  'stream-metrics',
])

export class AccessTokenScope extends S.Class<AccessTokenScope>('AccessTokenScope')({
  access_tokens: S.optional(S.NullOr(ResourceSet)),
  basins: S.optional(S.NullOr(ResourceSet)),
  op_groups: S.optional(S.NullOr(PermittedOperationGroups)),
  /**
   * Operations allowed for the token.
   * A union of allowed operations and groups is used as an effective set of allowed operations.
   */
  ops: S.optional(S.NullOr(S.Array(Operation))),
  streams: S.optional(S.NullOr(ResourceSet)),
}) {}

export class AccessTokenInfo extends S.Class<AccessTokenInfo>('AccessTokenInfo')({
  /**
   * Namespace streams based on the configured stream-level scope, which must be a prefix.
   * Stream name arguments will be automatically prefixed, and the prefix will be stripped when listing streams.
   */
  auto_prefix_streams: S.Boolean.pipe(S.optional, S.withDecodingDefault(Effect.succeed(false))),
  /**
   * Expiration time in ISO 8601 format.
   * If not set, the expiration will be set to that of the requestor's token.
   */
  expires_at: S.optional(S.NullOr(S.String)),
  /**
   * Access token ID.
   * It must be unique to the account and between 1 and 96 bytes in length.
   */
  id: S.String,
  /**
   * Access token scope.
   */
  scope: AccessTokenScope,
}) {}

export class ListAccessTokensResponse extends S.Class<ListAccessTokensResponse>('ListAccessTokensResponse')({
  /**
   * Matching access tokens.
   */
  access_tokens: S.Array(AccessTokenInfo).check(S.isMaxLength(1000)),
  /**
   * Indicates that there are more access tokens that match the criteria.
   */
  has_more: S.Boolean,
}) {}

export class ErrorResponse extends S.Class<ErrorResponse>('ErrorResponse')({
  code: S.optional(S.NullOr(S.String)),
  message: S.String,
}) {}

export class IssueAccessTokenResponse extends S.Class<IssueAccessTokenResponse>('IssueAccessTokenResponse')({
  /**
   * Created access token.
   */
  access_token: S.String,
}) {}

export class ListBasinsParams extends S.Class<ListBasinsParams>('ListBasinsParams')({
  prefix: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  start_after: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  limit: S.Int.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(1000)).pipe(S.optional, S.withDecodingDefault(Effect.succeed(1000))),
}) {}

export const BasinScope = S.Literal('aws:us-east-1')

export const BasinState = S.Literals(['active', 'creating', 'deleting'])

export class BasinInfo extends S.Class<BasinInfo>('BasinInfo')({
  /**
   * Basin name.
   */
  name: S.String,
  /**
   * Basin scope.
   */
  scope: BasinScope,
  /**
   * Basin state.
   */
  state: BasinState,
}) {}

export class ListBasinsResponse extends S.Class<ListBasinsResponse>('ListBasinsResponse')({
  /**
   * Matching basins.
   */
  basins: S.Array(BasinInfo).check(S.isMaxLength(1000)),
  /**
   * Indicates that there are more basins that match the criteria.
   */
  has_more: S.Boolean,
}) {}

export class DeleteOnEmptyConfig extends S.Class<DeleteOnEmptyConfig>('DeleteOnEmptyConfig')({
  /**
   * Minimum age in seconds before an empty stream can be deleted.
   * Set to 0 (default) to disable delete-on-empty (don't delete automatically).
   */
  min_age_secs: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
}) {}

export const InfiniteRetention = S.Record({ key: S.String, value: S.Unknown })

export const RetentionPolicy = S.Union([
  /**
   * Age in seconds for automatic trimming of records older than this threshold.
   * This must be set to a value greater than 0 seconds.
   * (While S2 is in public preview, this is capped at 28 days. Let us know if you'd like the cap removed.)
   */
  S.Struct({
    /**
     * Age in seconds for automatic trimming of records older than this threshold.
     * This must be set to a value greater than 0 seconds.
     * (While S2 is in public preview, this is capped at 28 days. Let us know if you'd like the cap removed.)
     */
    age: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  }),
  /**
   * Retain records unless explicitly trimmed.
   */
  S.Struct({
    /**
     * Retain records unless explicitly trimmed.
     */
    infinite: InfiniteRetention,
  }),
])

export const StorageClass = S.Literals(['standard', 'express'])

export const TimestampingMode = S.Literals(['client-prefer', 'client-require', 'arrival'])

export class TimestampingConfig extends S.Class<TimestampingConfig>('TimestampingConfig')({
  mode: S.optional(S.NullOr(TimestampingMode)),
  /**
   * Allow client-specified timestamps to exceed the arrival time.
   * If this is `false` or not set, client timestamps will be capped at the arrival time.
   */
  uncapped: S.optional(S.NullOr(S.Boolean)),
}) {}

export class StreamConfig extends S.Class<StreamConfig>('StreamConfig')({
  delete_on_empty: S.optional(S.NullOr(DeleteOnEmptyConfig)),
  retention_policy: S.optional(S.NullOr(RetentionPolicy)),
  storage_class: S.optional(S.NullOr(StorageClass)),
  timestamping: S.optional(S.NullOr(TimestampingConfig)),
}) {}

export class BasinConfig extends S.Class<BasinConfig>('BasinConfig')({
  /**
   * Create stream on append if it doesn't exist, using the default stream configuration.
   */
  create_stream_on_append: S.optional(S.NullOr(S.Boolean)),
  /**
   * Create stream on read if it doesn't exist, using the default stream configuration.
   */
  create_stream_on_read: S.optional(S.NullOr(S.Boolean)),
  default_stream_config: S.optional(S.NullOr(StreamConfig)),
}) {}

export class CreateBasinRequest extends S.Class<CreateBasinRequest>('CreateBasinRequest')({
  /**
   * Basin name which must be globally unique.
   * It can be between 8 and 48 characters in length, and comprise lowercase letters, numbers and hyphens.
   * It cannot begin or end with a hyphen.
   */
  basin: S.String,
  config: S.optional(S.NullOr(BasinConfig)),
  /**
   * Basin scope.
   */
  scope: BasinScope.pipe(S.optional, S.withDecodingDefault(Effect.succeed('aws:us-east-1'))),
}) {}

export class CreateOrReconfigureBasinParams extends S.Class<CreateOrReconfigureBasinParams>('CreateOrReconfigureBasinParams')({
  's2-request-token': S.optional(S.NullOr(S.String)),
}) {}

export const CreateOrReconfigureBasinRequest = S.Union([S.Null])
// export class CreateOrReconfigureBasinRequest extends S.Union(S.Null, CreateOrReconfigureBasinRequest) {}

export class DeleteOnEmptyReconfiguration extends S.Class<DeleteOnEmptyReconfiguration>('DeleteOnEmptyReconfiguration')(
  {
    /**
     * Minimum age in seconds before an empty stream can be deleted.
     * Set to 0 to disable delete-on-empty (don't delete automatically).
     */
    min_age_secs: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  },
) {}

export class TimestampingReconfiguration extends S.Class<TimestampingReconfiguration>('TimestampingReconfiguration')({
  mode: S.optional(S.NullOr(TimestampingMode)),
  /**
   * Allow client-specified timestamps to exceed the arrival time.
   */
  uncapped: S.optional(S.NullOr(S.Boolean)),
}) {}

export class StreamReconfiguration extends S.Class<StreamReconfiguration>('StreamReconfiguration')({
  delete_on_empty: S.optional(S.NullOr(DeleteOnEmptyReconfiguration)),
  retention_policy: S.optional(S.NullOr(RetentionPolicy)),
  storage_class: S.optional(S.NullOr(StorageClass)),
  timestamping: S.optional(S.NullOr(TimestampingReconfiguration)),
}) {}

export class BasinReconfiguration extends S.Class<BasinReconfiguration>('BasinReconfiguration')({
  /**
   * Create a stream on append.
   */
  create_stream_on_append: S.optional(S.NullOr(S.Boolean)),
  /**
   * Create a stream on read.
   */
  create_stream_on_read: S.optional(S.NullOr(S.Boolean)),
  default_stream_config: S.optional(S.NullOr(StreamReconfiguration)),
}) {}

export const AccountMetricSet = S.Literals(['active-basins', 'account-ops'])

export const TimeseriesInterval = S.Literals(['minute', 'hour', 'day'])

export class AccountMetricsParams extends S.Class<AccountMetricsParams>('AccountMetricsParams')({
  set: AccountMetricSet,
  start: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  end: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  interval: S.optional(S.NullOr(TimeseriesInterval)),
}) {}

export const MetricUnit = S.Literals(['bytes', 'operations'])

export class Scalar extends S.Class<Scalar>('Scalar')({
  /**
   * Metric name.
   */
  name: S.String,
  /**
   * Unit of the metric.
   */
  unit: MetricUnit,
  /**
   * Metric value.
   */
  value: S.Number,
}) {}

export class Accumulation extends S.Class<Accumulation>('Accumulation')({
  /**
   * The duration of bucket for the accumulation.
   */
  bucket_length: TimeseriesInterval,
  /**
   * Timeseries name.
   */
  name: S.String,
  /**
   * Unit of the metric.
   */
  unit: MetricUnit,
}) {}

export class Gauge extends S.Class<Gauge>('Gauge')({
  /**
   * Timeseries name.
   */
  name: S.String,
  /**
   * Unit of the metric.
   */
  unit: MetricUnit,
}) {}

export class Label extends S.Class<Label>('Label')({
  /**
   * Label name.
   */
  name: S.String,
  /**
   * Label values.
   */
  values: S.Array(S.String),
}) {}

export const Metric = S.Union([
  /**
   * Single named value.
   */
  S.Struct({
    /**
     * Single named value.
     */
    scalar: Scalar,
  }),
  /**
   * Named series of `(timestamp, value)` points representing an accumulation over a specified
   * bucket.
   */
  S.Struct({
    /**
     * Named series of `(timestamp, value)` points representing an accumulation over a specified
     * bucket.
     */
    accumulation: Accumulation,
  }),
  /**
   * Named series of `(timestamp, value)` points each representing an instantaneous value.
   */
  S.Struct({
    /**
     * Named series of `(timestamp, value)` points each representing an instantaneous value.
     */
    gauge: Gauge,
  }),
  /**
   * Set of string labels.
   */
  S.Struct({
    /**
     * Set of string labels.
     */
    label: Label,
  }),
])

export class MetricSetResponse extends S.Class<MetricSetResponse>('MetricSetResponse')({
  /**
   * Metrics comprising the set.
   */
  values: S.Array(Metric),
}) {}

export const BasinMetricSet = S.Literals([
  'storage',
  'append-ops',
  'read-ops',
  'read-throughput',
  'append-throughput',
  'basin-ops',
])

export class BasinMetricsParams extends S.Class<BasinMetricsParams>('BasinMetricsParams')({
  set: BasinMetricSet,
  start: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  end: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  interval: S.optional(S.NullOr(TimeseriesInterval)),
}) {}

export const StreamMetricSet = S.Literal('storage')

export class StreamMetricsParams extends S.Class<StreamMetricsParams>('StreamMetricsParams')({
  set: StreamMetricSet,
  start: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  end: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  interval: S.optional(S.NullOr(TimeseriesInterval)),
}) {}

export class ListStreamsParams extends S.Class<ListStreamsParams>('ListStreamsParams')({
  prefix: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  start_after: S.String.pipe(S.optional, S.withDecodingDefault(Effect.succeed(''))),
  limit: S.Int.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(1000)).pipe(S.optional, S.withDecodingDefault(Effect.succeed(1000))),
}) {}

export class StreamInfo extends S.Class<StreamInfo>('StreamInfo')({
  /**
   * Creation time in ISO 8601 format.
   */
  created_at: S.String,
  /**
   * Deletion time in ISO 8601 format, if the stream is being deleted.
   */
  deleted_at: S.optional(S.NullOr(S.String)),
  /**
   * Stream name.
   */
  name: S.String,
}) {}

export class ListStreamsResponse extends S.Class<ListStreamsResponse>('ListStreamsResponse')({
  /**
   * Indicates that there are more results that match the criteria.
   */
  has_more: S.Boolean,
  /**
   * Matching streams.
   */
  streams: S.Array(StreamInfo).check(S.isMaxLength(1000)),
}) {}

export class CreateStreamRequest extends S.Class<CreateStreamRequest>('CreateStreamRequest')({
  config: S.optional(S.NullOr(StreamConfig)),
  /**
   * Stream name that is unique to the basin.
   * It can be between 1 and 512 bytes in length.
   */
  stream: S.String,
}) {}

export class CreateOrReconfigureStreamParams extends S.Class<CreateOrReconfigureStreamParams>('CreateOrReconfigureStreamParams')({
  's2-request-token': S.optional(S.NullOr(S.String)),
}) {}

export const CreateOrReconfigureStreamRequest = S.Union([S.Null, StreamConfig])

export const S2Format = S.Literals(['raw', 'base64'])

export const U64 = S.Int.check(S.isGreaterThanOrEqualTo(0))

export class ReadParams extends S.Class<ReadParams>('ReadParams')({
  's2-format': S.optional(S.NullOr(S2Format)),
  seq_num: S.optional(S.NullOr(U64)),
  timestamp: S.optional(S.NullOr(U64)),
  tail_offset: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  count: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  bytes: S.optional(S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0)))),
  until: S.optional(S.NullOr(U64)),
  clamp: S.optional(S.NullOr(S.Boolean)),
}) {}

/**
 * Headers add structured information to a record as name-value pairs.
 *
 * The name cannot be empty, with the exception of an S2 command record.
 */
export const Header = S.NonEmptyArray(S.String).check(S.isMinLength(2), S.isMaxLength(2))

/**
 * Record that is durably sequenced on a stream.
 */
export class SequencedRecord extends S.Class<SequencedRecord>('SequencedRecord')({
  /**
   * Body of the record.
   */
  body: S.optional(S.NullOr(S.String)),
  /**
   * Series of name-value pairs for this record.
   */
  headers: S.optional(S.NullOr(S.Array(Header))),
  /**
   * Sequence number assigned by the service.
   */
  seq_num: U64,
  /**
   * Timestamp for this record.
   */
  timestamp: U64,
}) {}

/**
 * Position of a record in a stream.
 */
export class StreamPosition extends S.Class<StreamPosition>('StreamPosition')({
  /**
   * Sequence number assigned by the service.
   */
  seq_num: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  /**
   * Timestamp, which may be client-specified or assigned by the service.
   * If it is assigned by the service, it will represent milliseconds since Unix epoch.
   */
  timestamp: S.Int.check(S.isGreaterThanOrEqualTo(0)),
}) {}

export class ReadBatch extends S.Class<ReadBatch>('ReadBatch')({
  /**
   * Records that are durably sequenced on the stream, retrieved based on the requested criteria.
   * This can only be empty in response to a regular (non-SSE) read, if the request cannot be satisfied without violating an explicit limit.
   */
  records: S.Array(SequencedRecord),
  tail: S.optional(S.NullOr(StreamPosition)),
}) {}

export class TailResponse extends S.Class<TailResponse>('TailResponse')({
  /**
   * Sequence number that will be assigned to the next record on the stream, and timestamp of the last record.
   */
  tail: StreamPosition,
}) {}

export class AppendParams extends S.Class<AppendParams>('AppendParams')({
  's2-format': S.optional(S.NullOr(S2Format)),
}) {}

/**
 * Record to be appended to a stream.
 */
export class AppendRecord extends S.Class<AppendRecord>('AppendRecord')({
  /**
   * Body of the record.
   */
  body: S.optional(S.NullOr(S.String)),
  /**
   * Series of name-value pairs for this record.
   */
  headers: S.optional(S.NullOr(S.Array(Header))),
  timestamp: S.optional(S.NullOr(U64)),
}) {}

/**
 * Payload of an `append` request.
 */
export class AppendInput extends S.Class<AppendInput>('AppendInput')({
  /**
   * Enforce a fencing token, which starts out as an empty string that can be overridden by a `fence` command record.
   */
  fencing_token: S.optional(S.NullOr(S.String)),
  match_seq_num: S.optional(S.NullOr(U64)),
  /**
   * Batch of records to append atomically, which must contain at least one record, and no more than 1000.
   * The total size of a batch of records may not exceed 1 MiB of metered bytes.
   */
  records: S.Array(AppendRecord),
}) {}

/**
 * Success response to an `append` request.
 */
export class AppendAck extends S.Class<AppendAck>('AppendAck')({
  /**
   * Sequence number of the last record that was appended `+ 1`, and timestamp of the last record that was appended.
   * The difference between `end.seq_num` and `start.seq_num` will be the number of records appended.
   */
  end: StreamPosition,
  /**
   * Sequence number and timestamp of the first record that was appended.
   */
  start: StreamPosition,
  /**
   * Sequence number that will be assigned to the next record on the stream, and timestamp of the last record on the stream.
   * This can be greater than the `end` position in case of concurrent appends.
   */
  tail: StreamPosition,
}) {}

/**
 * Aborted due to a failed condition.
 */
export const AppendConditionFailed = S.Union([
  /**
   * Fencing token did not match.
   * The expected fencing token is returned.
   */
  S.Struct({
    /**
     * Fencing token did not match.
     * The expected fencing token is returned.
     */
    fencing_token_mismatch: S.String,
  }),
  /**
   * Sequence number did not match the tail of the stream.
   * The expected next sequence number is returned.
   */
  S.Struct({
    /**
     * Sequence number did not match the tail of the stream.
     * The expected next sequence number is returned.
     */
    seq_num_mismatch: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  }),
])

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {},
): Client => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => 'Unexpected status code'),
      (description) =>
        Effect.fail(
          new HttpClientError.StatusCodeError({
            request: response.request,
            response,
            description: typeof description === 'string' ? description : JSON.stringify(description),
          }),
        ),
    )
  const withResponse: <A, E>(
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
  ) => (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> =
    options.transformClient !== undefined
      ? (f) => (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            f,
          )
      : (f) => (request) => Effect.flatMap(httpClient.execute(request), f)
  const decodeSuccess =
    <A, I, R>(schema: S.Codec<A, I, R>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, A, I, R>(tag: Tag, schema: S.Codec<A, I, R>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)(response), (cause) =>
        Effect.fail(ClientError(tag, cause, response)),
      )
  return {
    httpClient,
    listAccessTokens: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/access-tokens`).pipe(
        HttpClientRequest.setUrlParams({
          prefix: options?.prefix as any,
          start_after: options?.start_after as any,
          limit: options?.limit as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(ListAccessTokensResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    issueAccessToken: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.post(`/access-tokens`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(IssueAccessTokenResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    revokeAccessToken: (id) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.delete(`/access-tokens/${id}`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '200': () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    listBasins: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/basins`).pipe(
        HttpClientRequest.setUrlParams({
          prefix: options?.prefix as any,
          start_after: options?.start_after as any,
          limit: options?.limit as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(ListBasinsResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createBasin: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.post(`/basins`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options),
        withResponse(
          HttpClientResponse.matchStatus({
            '200': decodeSuccess(BasinInfo),
            '201': decodeSuccess(BasinInfo),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '401': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getBasinConfig: (basin) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/basins/${basin}`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(BasinConfig),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createOrReconfigureBasin: (basin, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.put(`/basins/${basin}`).pipe(
        HttpClientRequest.setHeaders({ 's2-request-token': options.params?.['s2-request-token'] ?? undefined }),
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(
          HttpClientResponse.matchStatus({
            '200': decodeSuccess(BasinInfo),
            '201': decodeSuccess(BasinInfo),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '204': () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    deleteBasin: (basin) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.delete(`/basins/${basin}`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '400': decodeError('ErrorResponse', ErrorResponse),
            '401': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '202': () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    reconfigureBasin: (basin, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.patch(`/basins/${basin}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(BasinConfig),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    accountMetrics: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/metrics`).pipe(
        HttpClientRequest.setUrlParams({
          set: options?.set as any,
          start: options?.start as any,
          end: options?.end as any,
          interval: options?.interval as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(MetricSetResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    basinMetrics: (basin, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/metrics/${basin}`).pipe(
        HttpClientRequest.setUrlParams({
          set: options?.set as any,
          start: options?.start as any,
          end: options?.end as any,
          interval: options?.interval as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(MetricSetResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    streamMetrics: (basin, stream, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/metrics/${basin}/${stream}`).pipe(
        HttpClientRequest.setUrlParams({
          set: options?.set as any,
          start: options?.start as any,
          end: options?.end as any,
          interval: options?.interval as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(MetricSetResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    listStreams: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/streams`).pipe(
        HttpClientRequest.setUrlParams({
          prefix: options?.prefix as any,
          start_after: options?.start_after as any,
          limit: options?.limit as any,
        }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(ListStreamsResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createStream: (options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.post(`/streams`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(StreamInfo),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getStreamConfig: (stream) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/streams/${stream}`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(StreamConfig),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createOrReconfigureStream: (stream, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.put(`/streams/${stream}`).pipe(
        HttpClientRequest.setHeaders({ 's2-request-token': options.params?.['s2-request-token'] ?? undefined }),
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(StreamInfo),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            '204': () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    deleteStream: (stream) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.delete(`/streams/${stream}`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '202': () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    reconfigureStream: (stream, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.patch(`/streams/${stream}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(StreamConfig),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '403': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    read: (stream, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/streams/${stream}/records`).pipe(
        HttpClientRequest.setUrlParams({
          seq_num: options?.seq_num as any,
          timestamp: options?.timestamp as any,
          tail_offset: options?.tail_offset as any,
          count: options?.count as any,
          bytes: options?.bytes as any,
          until: options?.until as any,
          clamp: options?.clamp as any,
        }),
        HttpClientRequest.setHeaders({ 's2-format': options?.['s2-format'] ?? undefined }),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(ReadBatch),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '401': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            '416': decodeError('TailResponse', TailResponse),
            '500': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    append: (stream, options) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.post(`/streams/${stream}/records`).pipe(
        HttpClientRequest.setHeaders({ 's2-format': options.params?.['s2-format'] ?? undefined }),
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(AppendAck),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '401': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            '412': decodeError('AppendConditionFailed', AppendConditionFailed),
            '500': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    checkTail: (stream) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      HttpClientRequest.get(`/streams/${stream}/records/tail`).pipe(
        withResponse(
          HttpClientResponse.matchStatus({
            '2xx': decodeSuccess(TailResponse),
            '400': decodeError('ErrorResponse', ErrorResponse),
            '401': decodeError('ErrorResponse', ErrorResponse),
            '404': decodeError('ErrorResponse', ErrorResponse),
            '409': decodeError('ErrorResponse', ErrorResponse),
            '500': decodeError('ErrorResponse', ErrorResponse),
            orElse: unexpectedStatus,
          }),
        ),
      ),
  }
}

export interface Client {
  readonly httpClient: HttpClient.HttpClient
  /**
   * List access tokens.
   */
  readonly listAccessTokens: (
    options?: typeof ListAccessTokensParams.Encoded,
  ) => Effect.Effect<
    typeof ListAccessTokensResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Issue a new access token.
   */
  readonly issueAccessToken: (
    options: typeof AccessTokenInfo.Encoded,
  ) => Effect.Effect<
    typeof IssueAccessTokenResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Revoke an access token.
   */
  readonly revokeAccessToken: (
    id: string,
  ) => Effect.Effect<
    void,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * List basins.
   */
  readonly listBasins: (
    options?: typeof ListBasinsParams.Encoded,
  ) => Effect.Effect<
    typeof ListBasinsResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Create a basin.
   */
  readonly createBasin: (
    options: typeof CreateBasinRequest.Encoded,
  ) => Effect.Effect<
    typeof BasinInfo.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Get basin configuration.
   */
  readonly getBasinConfig: (
    basin: string,
  ) => Effect.Effect<
    typeof BasinConfig.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Create or reconfigure a basin.
   */
  readonly createOrReconfigureBasin: (
    basin: string,
    options: {
      readonly params?: typeof CreateOrReconfigureBasinParams.Encoded | undefined
      readonly payload: typeof CreateOrReconfigureBasinRequest.Encoded
    },
  ) => Effect.Effect<
    typeof BasinInfo.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Delete a basin.
   */
  readonly deleteBasin: (
    basin: string,
  ) => Effect.Effect<
    void,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Reconfigure a basin.
   */
  readonly reconfigureBasin: (
    basin: string,
    options: typeof BasinReconfiguration.Encoded,
  ) => Effect.Effect<
    typeof BasinConfig.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Account-level metrics.
   */
  readonly accountMetrics: (
    options: typeof AccountMetricsParams.Encoded,
  ) => Effect.Effect<
    typeof MetricSetResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Basin-level metrics.
   */
  readonly basinMetrics: (
    basin: string,
    options: typeof BasinMetricsParams.Encoded,
  ) => Effect.Effect<
    typeof MetricSetResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Stream-level metrics.
   */
  readonly streamMetrics: (
    basin: string,
    stream: string,
    options: typeof StreamMetricsParams.Encoded,
  ) => Effect.Effect<
    typeof MetricSetResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * List streams.
   */
  readonly listStreams: (
    options?: typeof ListStreamsParams.Encoded,
  ) => Effect.Effect<
    typeof ListStreamsResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Create a stream.
   */
  readonly createStream: (
    options: typeof CreateStreamRequest.Encoded,
  ) => Effect.Effect<
    typeof StreamInfo.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Get stream configuration.
   */
  readonly getStreamConfig: (
    stream: string,
  ) => Effect.Effect<
    typeof StreamConfig.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Create or reconfigure a stream.
   */
  readonly createOrReconfigureStream: (
    stream: string,
    options: {
      readonly params?: typeof CreateOrReconfigureStreamParams.Encoded | undefined
      readonly payload: typeof CreateOrReconfigureStreamRequest.Encoded
    },
  ) => Effect.Effect<
    typeof StreamInfo.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Delete a stream.
   */
  readonly deleteStream: (
    stream: string,
  ) => Effect.Effect<
    void,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Reconfigure a stream.
   */
  readonly reconfigureStream: (
    stream: string,
    options: typeof StreamReconfiguration.Encoded,
  ) => Effect.Effect<
    typeof StreamConfig.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
  /**
   * Read records.
   */
  readonly read: (
    stream: string,
    options?: typeof ReadParams.Encoded,
  ) => Effect.Effect<
    typeof ReadBatch.Type,
    | HttpClientError.HttpClientError
    | S.SchemaError
    | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
    | ClientError<'TailResponse', typeof TailResponse.Type>
  >
  /**
   * Append records.
   */
  readonly append: (
    stream: string,
    options: {
      readonly params?: typeof AppendParams.Encoded | undefined
      readonly payload: typeof AppendInput.Encoded
    },
  ) => Effect.Effect<
    typeof AppendAck.Type,
    | HttpClientError.HttpClientError
    | S.SchemaError
    | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
    | ClientError<'AppendConditionFailed', typeof AppendConditionFailed.Type>
  >
  /**
   * Check the tail.
   */
  readonly checkTail: (
    stream: string,
  ) => Effect.Effect<
    typeof TailResponse.Type,
    HttpClientError.HttpClientError | S.SchemaError | ClientError<'ErrorResponse', typeof ErrorResponse.Type>
  >
}

export interface ClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class ClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const ClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): ClientError<Tag, E> =>
  new ClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any
