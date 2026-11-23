package com.simmanager.app

import android.content.ContentResolver
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Exposes the SMS inbox to Dart, filtered to the operator's 913 sender.
 *
 * Only the voucher messages are needed, so the query is narrow: sender = 913,
 * newest first, capped. Parsing happens in Dart, where it can be unit-tested
 * without a device.
 */
class MainActivity : FlutterActivity() {

    private val channelName = "icc_record_scanner/sms"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "readSender" -> {
                        val sender = call.argument<String>("sender") ?: "913"
                        val limit = call.argument<Int>("limit") ?: 2000
                        try {
                            result.success(readMessages(sender, limit))
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

    private fun readMessages(sender: String, limit: Int): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        val resolver: ContentResolver = contentResolver

        // address is the sender; body carries the amount and the timestamp.
        resolver.query(
            Uri.parse("content://sms/inbox"),
            arrayOf("_id", "address", "body", "date"),
            "address = ?",
            arrayOf(sender),
            "date DESC"
        )?.use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow("_id")
            val bodyIdx = cursor.getColumnIndexOrThrow("body")
            val dateIdx = cursor.getColumnIndexOrThrow("date")
            var read = 0
            while (cursor.moveToNext() && read < limit) {
                out.add(
                    mapOf(
                        "id" to cursor.getLong(idIdx).toString(),
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
