/**
 * The guided deploy: a BotkitConversation that asks for a service and an environment,
 * asks for a typed confirmation before a production deploy, then ships it.
 *
 *   default:  service -> env --staging--> ship
 *                            --production--> confirm --match--> ship
 *                                                    --no match--> canceled
 *
 * "cancel" (or "stop") answers any question by leaving the dialog, through the aborted thread.
 *
 * Every question has a key (service, env, confirm), so the same dialog can be answered
 * by a person, by an answers file in CI (`--answers`), or by an AI agent over MCP.
 */
const { BotkitConversation } = require('botkit');

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = function(controller) {
    const { fleet, now } = controller.plugins.opsdesk;
    const services = fleet.names();

    const deploy = new BotkitConversation('deploy', controller);

    // Listed first at every question: while the dialog waits for an answer, it takes every message,
    // so the way out has to be one of the answers it understands.
    const cancel = {
        pattern: '^(cancel|stop)$',
        handler: async (answer, convo) => {
            await convo.gotoThread('aborted');
        }
    };

    deploy.ask({
        text: ['Which service?'],
        quick_replies: services.map((name) => ({ title: name, payload: name }))
    }, [
        cancel,
        {
            pattern: `^(${ services.map(escapeRegExp).join('|') })$`,
            handler: async (answer, convo) => {
                // patterns ignore case; store the canonical name
                convo.setVar('service', answer.toLowerCase());
            }
        },
        {
            default: true,
            handler: async (answer, convo, bot) => {
                await bot.say(`Unknown service "${ answer || '' }".`);
                await convo.repeat();
            }
        }
    ], 'service');

    deploy.ask({
        text: ['Deploy {{{vars.service}}} to which environment?'],
        quick_replies: [
            { title: 'Staging', payload: 'staging' },
            { title: 'Production', payload: 'production' }
        ]
    }, [
        cancel,
        {
            pattern: '^production$',
            handler: async (answer, convo) => {
                convo.setVar('env', 'production');
                await convo.gotoThread('confirm');
            }
        },
        {
            pattern: '^staging$',
            handler: async (answer, convo) => {
                convo.setVar('env', 'staging');
                await convo.gotoThread('ship');
            }
        },
        {
            default: true,
            handler: async (answer, convo, bot) => {
                await bot.say('Please choose Staging or Production.');
                await convo.repeat();
            }
        }
    ], 'env');

    deploy.addQuestion({
        text: ['Type the service name ({{{vars.service}}}) to confirm a PRODUCTION deploy.']
    }, [
        cancel,
        {
            default: true,
            handler: async (answer, convo) => {
                if (String(answer || '').trim().toLowerCase() === convo.vars.service) {
                    await convo.gotoThread('ship');
                } else {
                    await convo.gotoThread('canceled');
                }
            }
        }
    ], 'confirm', 'confirm');

    // The 'stop' action ends the dialog with vars._status 'canceled', which run() and afterDialog handlers can see.
    // (convo.stop() inside a handler would end it without setting a status.)
    deploy.addMessage('Confirmation did not match. Deploy canceled.', 'canceled');
    deploy.addAction('stop', 'canceled');

    deploy.addMessage('Deploy canceled.', 'aborted');
    deploy.addAction('stop', 'aborted');

    deploy.before('ship', async (convo) => {
        convo.setVar('version', fleet.deploy(convo.vars.service, convo.vars.env));
    });
    deploy.addMessage('Deployed {{{vars.service}}} {{{vars.version}}} to {{{vars.env}}}.', 'ship');
    deploy.addAction('complete', 'ship');

    controller.addDialog(deploy);

    controller.hears(/^deploy$/i, 'message', async (bot) => {
        await bot.beginDialog('deploy');
    });

    controller.afterDialog('deploy', async (bot, results) => {
        if (results._status === 'completed') {
            fleet.audit.push({
                service: results.service,
                env: results.env,
                version: results.version,
                user: results.user,
                at: new Date(now()).toISOString()
            });
        }
    });
};
