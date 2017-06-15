"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const util = require("util");
const _ = require("lodash");
const builder = require("botbuilder");
const request = require("request");
const ApplicationInsights = require("applicationinsights");
const events_1 = require("./events");
exports.currentBotName = "currentBotName";
function setCurrentBotName(session, botName) {
    session.dialogData[exports.currentBotName] = botName;
    return session;
}
exports.setCurrentBotName = setCurrentBotName;
class BotFrameworkInstrumentation {
    constructor(settings) {
        this.console = {};
        this.methods = {
            "debug": 0,
            "info": 1,
            "log": 2,
            "warn": 3,
            "error": 4
        };
        this.customFields = {};
        this.sentiments = {
            minWords: 3,
            url: 'https://westus.api.cognitive.microsoft.com/text/analytics/v2.0/sentiment',
            id: 'bot-analytics',
            key: null
        };
        settings = settings || {};
        _.extend(this.sentiments, settings.sentiments);
        this.sentiments.key = (this.sentiments) ? this.sentiments.key : process.env.CG_SENTIMENT_KEY;
        this.instrumentationKey = settings.instrumentationKey || process.env.APPINSIGHTS_INSTRUMENTATIONKEY;
        if (!this.instrumentationKey) {
            throw new Error('App Insights instrumentation key was not provided in options or the environment variable APPINSIGHTS_INSTRUMENTATIONKEY');
        }
        if (!this.sentiments.key) {
            console.warn('No sentiment key was provided - text sentiments will not be collected');
        }
    }
    formatArgs(args) {
        return util.format.apply(util.format, Array.prototype.slice.call(args));
    }
    setupConsoleCollection() {
        _.keys(this.methods).forEach(method => {
            console[method] = (() => {
                let original = console.log;
                return (...args) => {
                    let stdout;
                    try {
                        let msg = this.formatArgs(args);
                        this.trackTrace(msg, this.methods[method]);
                        stdout = process.stdout;
                        process.stdout = process.stderr;
                        original.apply(console, args);
                    }
                    finally {
                        process.stdout = stdout || process.stdout;
                    }
                };
            })();
        });
    }
    collectSentiment(session, text) {
        if (!this.sentiments.key)
            return;
        if (text.match(/\S+/g).length < this.sentiments.minWords)
            return;
        let message = session.message || {};
        let timestamp = message.timestamp;
        let address = message.address || {};
        let conversation = address.conversation || {};
        let user = address.user || {};
        request({
            url: this.sentiments.url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': this.sentiments.key
            },
            json: true,
            body: {
                "documents": [
                    {
                        "language": "en",
                        "id": this.sentiments.id,
                        "text": text
                    }
                ]
            }
        }, (error, response, body) => {
            if (error) {
                return this.trackException(error);
            }
            try {
                let result = _.find(body.documents, { id: this.sentiments.id }) || {};
                var score = result.score || null;
                if (isNaN(score)) {
                    throw new Error('Could not collect sentiment');
                }
                var item = {
                    text: text,
                    score: score,
                    timestamp: timestamp,
                    channel: address.channelId,
                    conversationId: conversation.id,
                    userId: user.id,
                    userName: user.name
                };
                this.trackEvent(events_1.default.Sentiment.name, item);
            }
            catch (error) {
                return this.trackException(error);
            }
        });
    }
    setupInstrumentation() {
        ApplicationInsights.setup(this.instrumentationKey)
            .setAutoCollectConsole(true)
            .setAutoCollectExceptions(true)
            .setAutoCollectRequests(true)
            .setAutoCollectPerformance(true)
            .start();
        this.appInsightsClient = ApplicationInsights.getClient(this.instrumentationKey);
    }
    monitor(bot) {
        this.setupInstrumentation();
        if (bot) {
            bot.use({
                botbuilder: (session, next) => {
                    try {
                        let message = session.message;
                        let address = message.address || {};
                        let conversation = address.conversation || {};
                        let user = address.user || {};
                        this.currentBot = session.dialogData[exports.currentBotName] || session.library.name;
                        let item = {
                            text: message.text,
                            type: message.type,
                            timestamp: message.timestamp,
                            conversationId: conversation.id,
                            channel: address.channelId,
                            userId: user.id,
                            userName: user.name,
                            locale: session.preferredLocale(),
                            botName: this.currentBot
                        };
                        console.log("\nBOTNAME: ", item.botName, "\n");
                        if (this.customFields) {
                            for (var key in this.customFields) {
                                item[key] = this.customFields[key];
                            }
                        }
                        this.trackEvent(events_1.default.UserMessage.name, item);
                        self.collectSentiment(session, message.text);
                    }
                    catch (e) {
                    }
                    finally {
                        next();
                    }
                },
                send: (message, next) => {
                    try {
                        let address = message.address || {};
                        let conversation = address.conversation || {};
                        let user = address.user || {};
                        let item = {
                            text: message.text,
                            type: message.type,
                            timestamp: message.timestamp,
                            conversationId: conversation.id,
                            botName: this.currentBot
                        };
                        this.trackEvent(events_1.default.BotMessage.name, item);
                    }
                    catch (e) {
                    }
                    finally {
                        next();
                    }
                }
            });
        }
        let self = this;
        builder.IntentDialog.prototype.recognize = (() => {
            let _recognize = builder.IntentDialog.prototype.recognize;
            return function (context, cb) {
                let _dialog = this;
                _recognize.apply(_dialog, [context, (err, result) => {
                        let message = context.message;
                        let address = message.address || {};
                        let conversation = address.conversation || {};
                        let user = address.user || {};
                        let item = {
                            text: message.text,
                            timestamp: message.timestamp,
                            intent: result && result.intent,
                            channel: address.channelId,
                            score: result && result.score,
                            withError: !err,
                            error: err,
                            conversationId: conversation.id,
                            userId: user.id,
                            userName: user.name
                        };
                        self.trackEvent(events_1.default.Intent.name, item);
                        if (result && result.entities) {
                            result.entities.forEach(value => {
                                let entityItem = _.clone(item);
                                entityItem.entityType = value.type;
                                entityItem.entityValue = value.entity;
                                self.trackEvent(events_1.default.Entity.name, entityItem);
                            });
                        }
                        return cb(err, result);
                    }]);
            };
        })();
    }
    startTransaction(context, name = '') {
        let message = context.message;
        let address = message.address || {};
        let conversation = address.conversation || {};
        let user = address.user || {};
        let item = {
            name: name,
            timestamp: message.timestamp,
            channel: address.channelId,
            conversationId: conversation.id,
            userId: user.id,
            userName: user.name
        };
        this.trackEvent(events_1.default.StartTransaction.name, item);
    }
    endTransaction(context, name = '', successful = true) {
        let message = context.message;
        let address = message.address || {};
        let conversation = address.conversation || {};
        let user = address.user || {};
        let item = {
            name: name,
            successful: successful.toString(),
            timestamp: message.timestamp,
            channel: address.channelId,
            conversationId: conversation.id,
            userId: user.id,
            userName: user.name
        };
        this.trackEvent(events_1.default.EndTransaction.name, item);
    }
    logCustomEvent(eventName, properties) {
        this.trackEvent(eventName, properties);
    }
    logCustomError(error, properties) {
        this.trackException(error, properties);
    }
    trackEvent(name, properties, measurements, tagOverrides, contextObjects) {
        console.log("\nTRACK EVENT -------\nCLIENT: ", this.instrumentationKey, "\nEVENT: ", name, "\nPROPS: ", JSON.stringify(properties, null, 2), "\nTRACK EVENT -------\n");
        this.appInsightsClient.trackEvent(name, properties, measurements, tagOverrides, contextObjects);
    }
    trackTrace(message, severityLevel, properties, tagOverrides, contextObjects) {
        console.log("\nTRACK TRACE -------\nCLIENT: ", this.instrumentationKey, "\nEVENT: ", message, "\nSEC-LEVEL: ", severityLevel, "\nPROPS: ", JSON.stringify(properties, null, 2), "\nTRACK TRACE -------\n");
        this.appInsightsClient.trackTrace(message, severityLevel, properties, tagOverrides, contextObjects);
    }
    trackException(exception, properties, measurements, tagOverrides, contextObjects) {
        console.log("\nTRACK EXCEPTION -------\nCLIENT: ", this.instrumentationKey, "\nEVENT: ", exception, "\nEXCEPTION: ", exception, "\nPROPS: ", JSON.stringify(properties, null, 2), "\nTRACK EXCEPTION -------\n");
        this.appInsightsClient.trackException(exception, properties, measurements, tagOverrides, contextObjects);
    }
}
exports.BotFrameworkInstrumentation = BotFrameworkInstrumentation;
//# sourceMappingURL=/Users/lilian/GitHub/botbuilder-instrumentation/dist/main.js.map