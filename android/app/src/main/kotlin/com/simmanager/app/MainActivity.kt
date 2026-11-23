package com.simmanager.app

import android.content.ContentResolver
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Exposes the SMS inbox to Dart.
 *
 * The selection is deliberately loose: messages are matched by the sender code
 * (913) OR by a body substring (the payer MSISDN). Filtering only on the sender
 * missed messages that arrived from a different shortcode but describe the same
 * payer, which is how a phone total drifts from the real one.
 *
 * Parsing happens in Dart, where it can be unit-tested without a device.
 */
class MainActivity : FlutterActivity() {

    private val channelName = "icc_record_scanner/sms"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "readVouchers" -> {
                        val senders = call.argument<List<String>>("senders") ?: listOf("913")
                        val bodyContains = call.argument<String>("bodyContains")
                        val limit = call.argument<Int>("limit") ?: 2000
                        try {
                            result.success(readMessages(senders, bodyContains, limit))
                        } catch (e: SecurityException) {
                            result.error("PERMISSION_DENIED", "READ_SMS not granted", null)
                        } catch (e: Exception) {
                            result.error("SMS_FAILED", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun readMessages(
        senders: List<String>,
        bodyContains: String?,
        limit: Int
    ): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        val resolver: ContentResolver = contentResolver

        val clauses = ArrayList<String>()
        val args = ArrayList<String>()

        if (senders.isNotEmpty()) {
            clauses.add("address IN (" + senders.joinToString(",") { "?" } + ")")
            args.addAll(senders)
        }
        if (!bodyContains.isNullOrBlank()) {
            clauses.add("body LIKE ?")
            args.add("%$bodyContains%")
        }
        val selection = if (clauses.isEmpty()) null else clauses.joinToString(" OR ")

        resolver.query(
            Uri.parse("content://sms/inbox"),
            arrayOf("_id", "address", "body", "date"),
            selection,
            if (args.isEmpty()) null else args.toTypedArray(),
            "date DESC"
        )?.use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow("_id")
            val addrIdx = cursor.getColumnIndexOrThrow("address")
            val bodyIdx = cursor.getColumnIndexOrThrow("body")
            val dateIdx = cursor.getColumnIndexOrThrow("date")
            var read = 0
            while (cursor.moveToNext() && read < limit) {
                out.add(
                    mapOf(
                        "id" to cursor.getLong(idIdx).toString(),
                        "sender" to (cursor.getString(addrIdx) ?: ""),
                        "body" to (cursor.getString(bodyIdx) ?: ""),
                        "date" to cursor.getLong(dateIdx)
                    )
                )
                read++
            }
        }
        return out
    }
}
